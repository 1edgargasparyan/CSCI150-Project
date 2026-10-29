// =====================================================================
// Reserve and Check-In/Out - ESP32 RFID reader
// Original firmware by Edgar; backend connection added (search "NEW").
//
// Before compiling:
//   1. Copy secrets.example.h to secrets.h and fill in the values
//   2. Library Manager: install "ArduinoJson" (version 7.x)
// =====================================================================

// Include Required Libraries
#include <Wire.h>              // I2C hardware library for clock on pin 21 and 22
#include <Adafruit_GFX.h>      // Graphics engine
#include <Adafruit_SSD1306.h>  // Driver to translate graphics to I2C commands
#include <Adafruit_PN532.h>    // Driver for the RFID module
#include <WiFi.h>              // Enables 2.4 GHz WiFi
#include <WiFiClientSecure.h>  // Loads cryptography to handle TLS encryption
#include <HTTPClient.h>        // Packages data into standard formats to send to backend
#include <ArduinoJson.h>       // NEW: builds the request and reads the reply safely
#include "secrets.h"           // NEW: WiFi, Supabase URL/key, reader ID, device key

// Hardware Pins
#define LED_GREEN_PIN 25 // Defines the green LED pin as 25
#define LED_RED_PIN   26 // Defines the red LED pin as 26
#define BUZZER_PIN    18 // Defines the buzzer pin as 18
#define TOUCH_PIN     4  // Defines the capacitive touch pin as 4

// Screen Settings
#define SCREEN_WIDTH 128 // OLED display pixel width
#define SCREEN_HEIGHT 64 // OLED display pixel height

// Create the screen and NFC reader objects
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1); // Create display object
Adafruit_PN532 nfc(-1, -1); // Create RFID object with no interrupts

// NEW: WiFi credentials and READER_ID moved to secrets.h

// Track whether we are checking out a room or equipment
enum SystemMode { MODE_ROOM, MODE_EQUIPMENT };
SystemMode currentMode = MODE_ROOM;

// Touch sensor sensitivity threshold
const int TOUCH_THRESHOLD = 200; // 70 in air but below 30 at touch

// Function Declarations
void updateDisplay(String mainMsg, String subMsg);
void playSuccessBeep();
void playDeniedBeep();
void handleTouchToggle();
void handleRFIDScan();
String scanCardNonBlocking(unsigned long timeoutMillis);
int sendScan(const String& cardUID, const String& equipmentUID, String& message); // NEW
void showIdleScreen(); // NEW

// Setup runs when ESP turns on
void setup()
{
  Serial.begin(115200); // Default speed

  // Set pins to output mode
  pinMode(LED_GREEN_PIN, OUTPUT);
  pinMode(LED_RED_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);

  // Start the I2C clock/bus for the screen and reader
  Wire.begin();

  // Turn on the screen
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) // Initialize display at address 0x3C
  {
    while (true); // Stop if screen fails
  }

  // Turn on the NFC reader
  nfc.begin();
  if (!nfc.getFirmwareVersion()) // Ping the PN532
  {
    updateDisplay("ERROR", "PN532 Init Failed");
    while (true); // Stop if reader fails
  }
  nfc.SAMConfig(); // Secure Access Module reading mode activation

  // Connect to Wi-Fi
  updateDisplay("BOOTING...", "Connecting to WiFi");
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true); // NEW: rejoin automatically if WiFi drops
  WiFi.begin(WIFI_SSID, WIFI_PASS); // Hands login credentials to signal
  while (WiFi.status() != WL_CONNECTED) // Wait until WiFi connects
  {
    delay(500);
  }
  Serial.print("WiFi connected, IP: ");
  Serial.println(WiFi.localIP());

  // Show the starting screen
  showIdleScreen();
}

// Main loop
void loop()
{
  handleTouchToggle(); // Check if the user touched the mode wire
  handleRFIDScan();    // Check if a card is near the reader
  delay(50);           // Short delay for stability
}

// Mode Switch Logic
void handleTouchToggle()
{
  static unsigned long lastTouchTime = 0;
  static bool wasTouched = false;

  // Read the bare jumper wire
  int touchValue = touchRead(TOUCH_PIN);

  // If touched and 400 milliseconds have passed (debouncing)
  if (touchValue < TOUCH_THRESHOLD && !wasTouched && (millis() - lastTouchTime > 400))
  {
    wasTouched = true;
    lastTouchTime = millis();

    // Flip the mode
    currentMode = (currentMode == MODE_ROOM) ? MODE_EQUIPMENT : MODE_ROOM;
    showIdleScreen();

    tone(BUZZER_PIN, 2000, 50); // Play a click sound
  }
  else if (touchValue >= TOUCH_THRESHOLD)
  {
    wasTouched = false; // Reset when finger is removed
  }
}

// RFID Scanning
void handleRFIDScan()
{
  // Wait for a user to tap their ID card
  String userUID = scanCardNonBlocking(100); // Scan card with 100ms timeout
  if (userUID == "")
  {
    return; // Exit if no card is found
  }

  tone(BUZZER_PIN, 3000, 20); // Play click sound

  // NEW: declared here (was inside the if-block) so it is still in scope
  // when we send the request below. Stays "" in room mode.
  String equipmentUID = "";

  // Equipment Scan Logic
  if (currentMode == MODE_EQUIPMENT)
  {
    unsigned long scanStartTime = millis();
    bool equipmentScanned = false;

    // Give the user 10 seconds to scan the equipment tag
    while (millis() - scanStartTime < 10000)
    {
      // Calculate how many seconds are left
      int timeRemaining = 10 - ((millis() - scanStartTime) / 1000);
      updateDisplay("Tap equipment", "Timeout in: " + String(timeRemaining) + "s");

      // Try to read a second tag
      equipmentUID = scanCardNonBlocking(200);

      // Check if tag scanned and it is not the UID
      if (equipmentUID != "" && equipmentUID != userUID)
      {
        equipmentScanned = true;
        tone(BUZZER_PIN, 3000, 20);
        break; // Stop the timer loop
      }
    }

    // If 10 seconds passed and no equipment was scanned
    if (!equipmentScanned)
    {
      updateDisplay("Timed out", "Start again");
      delay(2000);
      showIdleScreen();
      return; // Cancel checkout - nothing is sent (FR13)
    }
  }

  // Process the Data
  updateDisplay("PROCESSING...", "Sending Data...");

  // NEW: real backend call (replaces simulateBackend200OK)
  String message;
  int code = sendScan(userUID, equipmentUID, message);

  if (code == 200)
  {
    // Success Workflow - message is "Checked in" or "Checked out"
    digitalWrite(LED_GREEN_PIN, HIGH);
    playSuccessBeep();
    updateDisplay(message, "Success");
    delay(2000); // Leave screen on for 2 seconds
    digitalWrite(LED_GREEN_PIN, LOW);
  }
  else if (code == 403)
  {
    // Denied Workflow - message is the reason, e.g. "Room is reserved" (FR16)
    digitalWrite(LED_RED_PIN, HIGH);
    playDeniedBeep();
    updateDisplay(message, "Access Denied");
    delay(2000); // Leave screen on for 2 seconds (also the FR25 2-second lockout)
    digitalWrite(LED_RED_PIN, LOW);
  }
  else
  {
    // NEW: WiFi or backend unreachable - flash red (FR1 diagnostic)
    updateDisplay("Network error", message);
    for (int i = 0; i < 4; i++)
    {
      digitalWrite(LED_RED_PIN, HIGH);
      delay(250);
      digitalWrite(LED_RED_PIN, LOW);
      delay(250);
    }
  }

  // Return to the starting screen
  showIdleScreen();
}

// NEW: Send one scan to Supabase.
// Returns the HTTP status (200 or 403), or -1 if the backend can't be reached.
// 'message' receives the text to show on the OLED.
int sendScan(const String& cardUID, const String& equipmentUID, String& message)
{
  if (WiFi.status() != WL_CONNECTED)
  {
    message = "No WiFi";
    return -1;
  }

  WiFiClientSecure client;
  // Encrypts traffic but does not verify the server's certificate.
  // OK for testing; before the final demo switch to client.setCACert(...).
  client.setInsecure();

  HTTPClient https;
  https.setTimeout(5000); // 5 seconds max
  if (!https.begin(client, String(SUPABASE_URL) + "/rest/v1/rpc/handle_scan"))
  {
    message = "Bad backend URL";
    return -1;
  }
  https.addHeader("Content-Type", "application/json");
  https.addHeader("apikey", SUPABASE_ANON_KEY);
  https.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);

  // Build the JSON body. Key names must match handle_scan's parameters.
  JsonDocument request;
  request["card_uid"]   = cardUID;
  request["reader_id"]  = READER_ID;
  request["device_key"] = DEVICE_KEY;
  if (equipmentUID.length() > 0)
  {
    request["equipment_uid"] = equipmentUID;
  }
  String body;
  serializeJson(request, body);

  // Log what we're sending WITHOUT the device key
  Serial.println("Scan -> card " + cardUID + (equipmentUID.length() ? ", equipment " + equipmentUID : ""));

  int code = https.POST(body);
  String response = (code > 0) ? https.getString() : "";
  https.end();

  Serial.printf("HTTP %d: %s\n", code, response.c_str());

  if (code <= 0)
  {
    message = "Backend unreachable";
    return -1;
  }

  // Read {"ok": true/false, "message": "..."}
  JsonDocument reply;
  if (deserializeJson(reply, response))
  {
    message = "Bad response";
    return code;
  }
  message = String(reply["message"] | "Unknown error");
  return code;
}

// NEW: idle screen for the current mode (FR16)
void showIdleScreen()
{
  if (currentMode == MODE_ROOM)
  {
    updateDisplay("Tap to Check In", "Room Access Active");
  }
  else
  {
    updateDisplay("Tap ID card", "Equipment Station");
  }
}

// Read card and return a string
String scanCardNonBlocking(unsigned long timeoutMillis)
{
  uint8_t uid[7]; // MIFARE UID length
  uint8_t uidLength;

  // Ask PN532 coil if it sees a card
  if (nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &uidLength, timeoutMillis))
  {
    String uidString = "";

    // Convert the raw bytes into a hexadecimal string
    for (uint8_t i = 0; i < uidLength; i++) // Cycle through each byte
    {
      if (uid[i] < 0x10) uidString += "0"; // Include leading 0 if less than 16
      uidString += String(uid[i], HEX);    // Creates the string
    }

    uidString.toUpperCase(); // Sets all hex as uppercase
    return uidString;
  }

  return ""; // Return empty if nothing is found
}

// OLED and Buzzer Controls
void updateDisplay(String mainMsg, String subMsg)
{
  display.clearDisplay();

  // Draw the top banner
  display.fillRect(0, 0, SCREEN_WIDTH, 16, SSD1306_WHITE); // Create white rectangle border
  display.setTextColor(SSD1306_BLACK); // Black text
  display.setTextSize(1);
  display.setCursor(5, 4);
  if (currentMode == MODE_ROOM)
  {
    display.print(">>> ROOM ACCESS <<<");
  }
  else
  {
    display.print(">> EQUIPMENT <<");
  }

  // Draw the main text
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 24);
  display.println(mainMsg);

  // Draw the bottom text
  display.setCursor(0, 42);
  display.println(subMsg);

  display.display(); // Push it to the screen
}

void playSuccessBeep()
{
  tone(BUZZER_PIN, 2500, 150); // One short high-pitched tone
}

void playDeniedBeep()
{
  // Two low tones
  tone(BUZZER_PIN, 300, 200);
  delay(250);
  tone(BUZZER_PIN, 300, 200);
}
