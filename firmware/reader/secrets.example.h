// =====================================================================
// secrets.example.h - TEMPLATE. Copy this file to "secrets.h" in the
// same folder and fill in the real values.
//
// secrets.h is listed in .gitignore. NEVER commit it.
// This is the one file to edit per location (FR21 non-functional).
// =====================================================================
#pragma once

// Wi-Fi (2.4 GHz)
#define WIFI_SSID          "bulldogs"
#define WIFI_PASS          ""

// Supabase project (Dashboard -> Connect, or ask Nick)
#define SUPABASE_URL       "https://ciybtljbqogoknnfffmv.supabase.co"
#define SUPABASE_ANON_KEY  "PASTE_ANON_KEY_HERE"   // public "anon" / publishable key. NOT service_role

// This reader (must match a row in the database "readers" table)
#define READER_ID          "ESP32_01"
#define DEVICE_KEY         "PASTE_DEVICE_KEY_HERE" // get from Nick in person or by direct message
