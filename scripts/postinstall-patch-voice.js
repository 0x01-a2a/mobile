/**
 * Patches @react-native-voice/voice for modern Gradle (8+) and AGP compatibility.
 *
 * Fixes:
 * 1. Removes `jcenter()` (deprecated and removed in Gradle 8)
 * 2. Adds `compileSdk` (required by modern AGP)
 */
const fs = require('fs');
const path = require('path');

const buildGradle = path.join(
  __dirname,
  '../node_modules/@react-native-voice/voice/android/build.gradle',
);

if (!fs.existsSync(buildGradle)) {
  // Package not installed — skip silently.
  process.exit(0);
}

let content = fs.readFileSync(buildGradle, 'utf8');

// Remove jcenter() — replaced by mavenCentral() which is already in project-level repos
content = content.replace(/\s*jcenter\(\)\n?/g, '\n');

// Replace the entire compileSdkVersion line with a fixed compileSdk
content = content.replace(
  /compileSdkVersion\s+.+/g,
  'compileSdk 34',
);

// Replace targetSdkVersion similarly
content = content.replace(
  /targetSdkVersion\s+.+/g,
  'targetSdkVersion 34',
);

// Replace DEFAULT_COMPILE_SDK_VERSION value
content = content.replace(
  /def DEFAULT_COMPILE_SDK_VERSION = \d+/,
  'def DEFAULT_COMPILE_SDK_VERSION = 34',
);

// Replace DEFAULT_TARGET_SDK_VERSION value
content = content.replace(
  /def DEFAULT_TARGET_SDK_VERSION = \d+/,
  'def DEFAULT_TARGET_SDK_VERSION = 34',
);

// Remove old Android Support Library — conflicts with AndroidX (duplicate classes)
content = content.replace(
  /implementation\s+"com\.android\.support:appcompat-v7:.*"/g,
  '// removed: com.android.support conflicts with AndroidX',
);
content = content.replace(
  /implementation\s+"com\.android\.support:.*"/g,
  '// removed: com.android.support conflicts with AndroidX',
);

fs.writeFileSync(buildGradle, content, 'utf8');
console.log('[postinstall] Patched @react-native-voice/voice build.gradle for Gradle 8+ / AGP');
