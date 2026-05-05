/**
 * Patches react-native-audio-recorder-player v3.6.x for modern Gradle/AGP/Kotlin.
 *
 * The package ships with:
 * - AGP 4.2.2 (incompatible with Gradle 8+)
 * - Kotlin 1.6.0 (incompatible with project Kotlin 1.9+)
 * - Its own buildscript block (conflicts with project-level plugin management)
 *
 * Fix: remove the entire buildscript block (let the project-level config handle
 * AGP/Kotlin) and ensure compileSdk is set.
 */
const fs = require('fs');
const path = require('path');

const buildGradle = path.join(
  __dirname,
  '../node_modules/react-native-audio-recorder-player/android/build.gradle',
);

if (!fs.existsSync(buildGradle)) {
  process.exit(0);
}

let content = fs.readFileSync(buildGradle, 'utf8');

// Remove the entire buildscript { ... } block — project-level handles this
content = content.replace(/buildscript\s*\{[\s\S]*?^}/m, '');

// Remove the classpath dependencies line if still present
content = content.replace(/classpath\s+"com\.android\.tools\.build:gradle:.*"/g, '');
content = content.replace(/classpath\s+"org\.jetbrains\.kotlin:kotlin-gradle-plugin:.*"/g, '');

// Ensure compileSdk is modern
content = content.replace(/compileSdkVersion\s+.*/g, 'compileSdk 34');
if (!content.includes('compileSdk')) {
  content = content.replace(/android\s*\{/, 'android {\n    compileSdk 34');
}

// Ensure targetSdkVersion is modern
content = content.replace(/targetSdkVersion\s+.*/g, 'targetSdkVersion 34');

// Replace minSdkVersion if too low
content = content.replace(/minSdkVersion\s+\d+/g, 'minSdkVersion 21');

fs.writeFileSync(buildGradle, content, 'utf8');
console.log('[postinstall] Patched react-native-audio-recorder-player build.gradle for Gradle 8+ / Kotlin 1.9+');
