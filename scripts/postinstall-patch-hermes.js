const fs = require('fs');
const path = require('path');

const hermescTargetPath = path.join(
  __dirname,
  '..',
  'node_modules',
  'react-native',
  'sdks',
  'hermes-engine',
  'utils',
  'build-hermesc-xcode.sh',
);

const hermesTargetPath = path.join(
  __dirname,
  '..',
  'node_modules',
  'react-native',
  'sdks',
  'hermes-engine',
  'utils',
  'build-hermes-xcode.sh',
);

const hermescNeedle = `SDKROOT=$(xcode-select -p)/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk

env -i \\
  PATH="$PATH" \\
  SDKROOT="$SDKROOT" \\
  "$CMAKE_BINARY" -S "\${PODS_ROOT}/hermes-engine" -B "$hermesc_dir_path" -DJSI_DIR="$jsi_path" -DCMAKE_BUILD_TYPE=Release

env -i \\
  PATH="$PATH" \\
  SDKROOT="$SDKROOT" \\
  "$CMAKE_BINARY" --build "$hermesc_dir_path" --target hermesc -j "$(sysctl -n hw.ncpu)"`;

const hermescReplacement = `SDKROOT=$(xcode-select -p)/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk
HOST_HOME="\${HOME:-$(dscl . -read /Users/"$USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')}"
HOST_USER="\${USER:-$(id -un)}"

env -i \\
  PATH="$PATH" \\
  HOME="$HOST_HOME" \\
  USER="$HOST_USER" \\
  SDKROOT="$SDKROOT" \\
  "$CMAKE_BINARY" -S "\${PODS_ROOT}/hermes-engine" -B "$hermesc_dir_path" -DJSI_DIR="$jsi_path" -DCMAKE_BUILD_TYPE=Release

env -i \\
  PATH="$PATH" \\
  HOME="$HOST_HOME" \\
  USER="$HOST_USER" \\
  SDKROOT="$SDKROOT" \\
  "$CMAKE_BINARY" --build "$hermesc_dir_path" --target hermesc -j "$(sysctl -n hw.ncpu)"`;

const hermesNeedle = `release_version="$1"; shift
hermesc_path="$1"; shift
jsi_path="$1"; shift

# Based on platform name returns the framework copy destination. Used later by \`vendored_frameworks\` in Podspec.
# Fallbacks to "ios" if platform is not recognized.
function get_platform_copy_destination {
    if [[ $1 == "macosx" ]]; then
      echo "macosx"
      return
    elif [[ $1 == "xros" || $1 == "xrsimulator" ]]; then
      echo "xros"
      return
    fi

    echo "ios"
}`;

const hermesReplacement = `release_version="$1"; shift
hermesc_path="$1"; shift
jsi_path="$1"; shift

HOST_HOME="\${HOME:-$(dscl . -read /Users/"$USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')}"
HOST_USER="\${USER:-$(id -un)}"

# Based on platform name returns the framework copy destination. Used later by \`vendored_frameworks\` in Podspec.
# Fallbacks to "ios" if platform is not recognized.
function get_platform_copy_destination {
    if [[ $1 == "macosx" ]]; then
      echo "macosx"
      return
    elif [[ $1 == "xros" || $1 == "xrsimulator" ]]; then
      echo "xros"
      return
    fi

    echo "ios"
}`;

const hermesEnvNeedle = `function get_deployment_target {
    if [[ $1 == "macosx" ]]; then
      echo "\${MACOSX_DEPLOYMENT_TARGET}"
      return
    elif [[ $1 == "xrsimulator" || $1 == "xros" ]]; then
      echo "\${XROS_DEPLOYMENT_TARGET}"
      return
    fi

    echo "\${IPHONEOS_DEPLOYMENT_TARGET}"
}`;

const hermesEnvReplacement = `function get_deployment_target {
    if [[ $1 == "macosx" ]]; then
      echo "\${MACOSX_DEPLOYMENT_TARGET}"
      return
    elif [[ $1 == "xrsimulator" || $1 == "xros" ]]; then
      echo "\${XROS_DEPLOYMENT_TARGET}"
      return
    fi

    echo "\${IPHONEOS_DEPLOYMENT_TARGET}"
}

function get_sdk_root {
    if [[ $1 == "catalyst" ]]; then
      xcrun --sdk macosx --show-sdk-path
      return
    fi

    if xcrun --sdk "$1" --show-sdk-path >/dev/null 2>&1; then
      xcrun --sdk "$1" --show-sdk-path
      return
    fi

    echo "\${SDKROOT}"
}`;

const hermesBuildNeedle = `architectures=$( echo "$ARCHS" | tr  " " ";" )

echo "Configure Apple framework"

"$CMAKE_BINARY" \\
  -S "\${PODS_ROOT}/hermes-engine" \\
  -B "\${PODS_ROOT}/hermes-engine/build/\${PLATFORM_NAME}" \\
  -DHERMES_EXTRA_LINKER_FLAGS="$xcode_15_flags" \\
  -DHERMES_APPLE_TARGET_PLATFORM:STRING="$PLATFORM_NAME" \\
  -DCMAKE_OSX_ARCHITECTURES:STRING="$architectures" \\
  -DCMAKE_OSX_DEPLOYMENT_TARGET:STRING="$deployment_target" \\
  -DHERMES_ENABLE_DEBUGGER:BOOLEAN="$enable_debugger" \\
  -DHERMES_ENABLE_INTL:BOOLEAN=true \\
  -DHERMES_ENABLE_LIBFUZZER:BOOLEAN=false \\
  -DHERMES_ENABLE_FUZZILLI:BOOLEAN=false \\
  -DHERMES_ENABLE_TEST_SUITE:BOOLEAN=false \\
  -DHERMES_ENABLE_BITCODE:BOOLEAN=false \\
  -DHERMES_BUILD_APPLE_FRAMEWORK:BOOLEAN=true \\
  -DHERMES_BUILD_SHARED_JSI:BOOLEAN=false \\
  -DCMAKE_CXX_FLAGS:STRING="-gdwarf" \\
  -DCMAKE_C_FLAGS:STRING="-gdwarf" \\
  -DIMPORT_HOST_COMPILERS:PATH="\${hermesc_path}" \\
  -DJSI_DIR="$jsi_path" \\
  -DHERMES_RELEASE_VERSION="for RN $release_version" \\
  -DCMAKE_BUILD_TYPE="$cmake_build_type" \\
  $boost_context_flag

echo "Build Apple framework"

"$CMAKE_BINARY" \\
  --build "\${PODS_ROOT}/hermes-engine/build/\${PLATFORM_NAME}" \\
  --target hermesvm \\
  -j "$(sysctl -n hw.ncpu)"

echo "Copy Apple framework to destroot/Library/Frameworks"

platform_copy_destination=$(get_platform_copy_destination $PLATFORM_NAME)

mkdir -p "\${PODS_ROOT}/hermes-engine/destroot/Library/Frameworks/\${platform_copy_destination}"
cp -pfR \\
  "\${PODS_ROOT}/hermes-engine/build/\${PLATFORM_NAME}/lib/hermesvm.framework" \\
  "\${PODS_ROOT}/hermes-engine/destroot/Library/Frameworks/\${platform_copy_destination}"`;

const hermesBuildReplacement = `architectures=$( echo "$ARCHS" | tr  " " ";" )
sdk_root=$(get_sdk_root "$PLATFORM_NAME")
build_dir="\${PODS_ROOT}/hermes-engine/build/\${PLATFORM_NAME}"

# Xcode 26/CMake can cache duplicate sysroots for simulator builds. Start clean.
rm -rf "$build_dir"

echo "Configure Apple framework"

env -i \\
  PATH="$PATH" \\
  HOME="$HOST_HOME" \\
  USER="$HOST_USER" \\
  SDKROOT="$sdk_root" \\
  "$CMAKE_BINARY" \\
  -S "\${PODS_ROOT}/hermes-engine" \\
  -B "$build_dir" \\
  -DHERMES_EXTRA_LINKER_FLAGS="$xcode_15_flags" \\
  -DHERMES_APPLE_TARGET_PLATFORM:STRING="$PLATFORM_NAME" \\
  -DCMAKE_OSX_ARCHITECTURES:STRING="$architectures" \\
  -DCMAKE_OSX_SYSROOT:STRING="$sdk_root" \\
  -DCMAKE_OSX_DEPLOYMENT_TARGET:STRING="$deployment_target" \\
  -DHERMES_ENABLE_DEBUGGER:BOOLEAN="$enable_debugger" \\
  -DHERMES_ENABLE_INTL:BOOLEAN=true \\
  -DHERMES_ENABLE_LIBFUZZER:BOOLEAN=false \\
  -DHERMES_ENABLE_FUZZILLI:BOOLEAN=false \\
  -DHERMES_ENABLE_TEST_SUITE:BOOLEAN=false \\
  -DHERMES_ENABLE_BITCODE:BOOLEAN=false \\
  -DHERMES_BUILD_APPLE_FRAMEWORK:BOOLEAN=true \\
  -DHERMES_BUILD_SHARED_JSI:BOOLEAN=false \\
  -DCMAKE_CXX_FLAGS:STRING="-gdwarf" \\
  -DCMAKE_C_FLAGS:STRING="-gdwarf" \\
  -DIMPORT_HOST_COMPILERS:PATH="\${hermesc_path}" \\
  -DJSI_DIR="$jsi_path" \\
  -DHERMES_RELEASE_VERSION="for RN $release_version" \\
  -DCMAKE_BUILD_TYPE="$cmake_build_type" \\
  $boost_context_flag

echo "Build Apple framework"

env -i \\
  PATH="$PATH" \\
  HOME="$HOST_HOME" \\
  USER="$HOST_USER" \\
  SDKROOT="$sdk_root" \\
  "$CMAKE_BINARY" \\
  --build "$build_dir" \\
  --target hermesvm \\
  -j "$(sysctl -n hw.ncpu)"

echo "Copy Apple framework to destroot/Library/Frameworks"

platform_copy_destination=$(get_platform_copy_destination $PLATFORM_NAME)

mkdir -p "\${PODS_ROOT}/hermes-engine/destroot/Library/Frameworks/\${platform_copy_destination}"
cp -pfR \\
  "$build_dir/lib/hermesvm.framework" \\
  "\${PODS_ROOT}/hermes-engine/destroot/Library/Frameworks/\${platform_copy_destination}"`;

function applyPatch({ targetPath, marker, transforms, label }) {
  if (!fs.existsSync(targetPath)) {
    console.log(`[postinstall] ${label} script not found at ${targetPath}, skipping.`);
    return;
  }

  let current = fs.readFileSync(targetPath, 'utf8');

  if (current.includes(marker)) {
    console.log(`[postinstall] ${label} patch already applied.`);
    return;
  }

  for (const [needle, replacement] of transforms) {
    if (!current.includes(needle)) {
      console.error(`[postinstall] ${label} script layout changed; patch not applied.`);
      process.exit(1);
    }

    current = current.replace(needle, replacement);
  }

  fs.writeFileSync(targetPath, current);
  console.log(`[postinstall] Applied ${label} patch.`);
}

applyPatch({
  targetPath: hermescTargetPath,
  marker: 'HOST_HOME="${HOME:-$(dscl . -read /Users/"$USER" NFSHomeDirectory',
  transforms: [[hermescNeedle, hermescReplacement]],
  label: 'Hermesc HOME',
});

applyPatch({
  targetPath: hermesTargetPath,
  marker: 'rm -rf "$build_dir"',
  transforms: [
    [hermesNeedle, hermesReplacement],
    [hermesEnvNeedle, hermesEnvReplacement],
    [hermesBuildNeedle, hermesBuildReplacement],
  ],
  label: 'Hermes Xcode 26',
});
