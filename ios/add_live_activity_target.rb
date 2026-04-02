#!/usr/bin/env ruby
# add_live_activity_target.rb
#
# Adds the AgentLiveActivity WidgetKit extension target to Zerox1.xcodeproj.
#
# Prerequisites:
#   gem install xcodeproj
#
# Usage:
#   cd /Users/tobiasd/Desktop/zerox1/mobile/ios
#   gem install xcodeproj
#   ruby add_live_activity_target.rb

require 'xcodeproj'
require 'fileutils'

PROJECT_PATH    = File.expand_path('Zerox1.xcodeproj', __dir__)
EXT_NAME        = 'AgentLiveActivity'
EXT_BUNDLE_ID   = 'world.zerox1.01pilot.AgentLiveActivity'
EXT_DIR         = File.expand_path('AgentLiveActivity', __dir__)
DEPLOY_TARGET   = '16.1'   # Live Activities require iOS 16.1+
SWIFT_VERSION   = '5.0'
MARKETING_VER   = '1.0'
PROJECT_VER     = '1'

project = Xcodeproj::Project.open(PROJECT_PATH)

# ── 1. Find / create the AgentLiveActivity group ────────────────────────────

main_group = project.main_group
ext_group = main_group.groups.find { |g| g.name == EXT_NAME } ||
            main_group.new_group(EXT_NAME, EXT_DIR)

puts "Group '#{EXT_NAME}' ready."

# ── 2. Add source files to the group ────────────────────────────────────────

source_files = %w[
  AgentActivityAttributes.swift
  AgentLiveActivityWidget.swift
  AgentLiveActivityBundle.swift
]

resource_files = %w[Info.plist]

entitlement_file = 'AgentLiveActivity.entitlements'

source_refs  = source_files.map do |name|
  ext_group.files.find { |f| f.path == name } ||
    ext_group.new_file(File.join(EXT_DIR, name))
end

info_plist_ref = ext_group.files.find { |f| f.path == 'Info.plist' } ||
                 ext_group.new_file(File.join(EXT_DIR, 'Info.plist'))

entitlements_ref = ext_group.files.find { |f| f.path == entitlement_file } ||
                   ext_group.new_file(File.join(EXT_DIR, entitlement_file))

puts "Source/resource file references added."

# ── 3. Create the native target ──────────────────────────────────────────────

existing = project.targets.find { |t| t.name == EXT_NAME }
if existing
  puts "Target '#{EXT_NAME}' already exists — removing it first."
  existing.remove_from_project
end

ext_target = project.new_target(
  :app_extension,
  EXT_NAME,
  :ios,
  DEPLOY_TARGET,
  project.products_group
)
ext_target.product_name = EXT_NAME

puts "Target '#{EXT_NAME}' created."

# ── 4. Build phases ──────────────────────────────────────────────────────────

# Sources phase — add .swift files
sources_phase = ext_target.source_build_phase
source_refs.each { |ref| sources_phase.add_file_reference(ref) }

# Resources phase — Info.plist is NOT added here (it's referenced via
# INFOPLIST_FILE build setting, same as the main app target pattern).
# No additional resource files needed for a widget extension.

# Frameworks phase — WidgetKit + SwiftUI
frameworks_phase = ext_target.frameworks_build_phase

def sdk_framework(project, name)
  ref = project.frameworks_group.files.find { |f| f.path == "#{name}.framework" }
  unless ref
    ref = project.frameworks_group.new_file("System/Library/Frameworks/#{name}.framework")
    ref.source_tree = 'SDKROOT'
    ref.last_known_file_type = 'wrapper.framework'
    ref.name = "#{name}.framework"
  end
  ref
end

widgetkit_ref = sdk_framework(project, 'WidgetKit')
swiftui_ref   = sdk_framework(project, 'SwiftUI')
frameworks_phase.add_file_reference(widgetkit_ref)
frameworks_phase.add_file_reference(swiftui_ref)

puts "Build phases configured."

# ── 5. Build configurations ──────────────────────────────────────────────────

common_settings = {
  'ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES' => 'NO',
  'CODE_SIGN_STYLE'                        => 'Automatic',
  'CURRENT_PROJECT_VERSION'                => PROJECT_VER,
  'GENERATE_INFOPLIST_FILE'                => 'NO',
  'INFOPLIST_FILE'                         => "#{EXT_NAME}/Info.plist",
  'IPHONEOS_DEPLOYMENT_TARGET'             => DEPLOY_TARGET,
  'LD_RUNPATH_SEARCH_PATHS'                => ['$(inherited)', '@executable_path/../../Frameworks'],
  'MARKETING_VERSION'                      => MARKETING_VER,
  'PRODUCT_BUNDLE_IDENTIFIER'              => EXT_BUNDLE_ID,
  'PRODUCT_NAME'                           => '$(TARGET_NAME)',
  'SKIP_INSTALL'                           => 'YES',
  'SUPPORTED_PLATFORMS'                    => 'iphoneos iphonesimulator',
  'SWIFT_VERSION'                          => SWIFT_VERSION,
  'TARGETED_DEVICE_FAMILY'                 => '1,2',
  'CODE_SIGN_ENTITLEMENTS'                 => "#{EXT_NAME}/#{entitlement_file}",
}

ext_target.build_configurations.each do |config|
  config.build_settings.merge!(common_settings)
  if config.name == 'Debug'
    config.build_settings['SWIFT_OPTIMIZATION_LEVEL'] = '-Onone'
    config.build_settings['DEBUG_INFORMATION_FORMAT']  = 'dwarf'
  else
    config.build_settings['SWIFT_OPTIMIZATION_LEVEL'] = '-O'
    config.build_settings['DEBUG_INFORMATION_FORMAT']  = 'dwarf-with-dsym'
  end
end

puts "Build configurations set."

# ── 6. Embed extension in the main app target ─────────────────────────────────

main_target = project.targets.find { |t| t.name == 'Zerox1' }
unless main_target
  abort "ERROR: Could not find main app target 'Zerox1'. Aborting."
end

# Add target dependency
dep = main_target.add_dependency(ext_target)
puts "Target dependency added: Zerox1 → #{EXT_NAME}"

# Find or create an "Embed App Extensions" copy-files phase
embed_phase = main_target.copy_files_build_phases.find do |p|
  p.name == 'Embed App Extensions'
end

unless embed_phase
  embed_phase = main_target.new_copy_files_build_phase('Embed App Extensions')
  embed_phase.dst_subfolder_spec = Xcodeproj::Constants::COPY_FILES_BUILD_PHASE_DESTINATIONS[:plugins]
end

# Add the extension product reference to the embed phase
ext_product_ref = ext_target.product_reference
unless embed_phase.files_references.map(&:uuid).include?(ext_product_ref.uuid)
  build_file = embed_phase.add_file_reference(ext_product_ref)
  build_file.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
end

puts "Extension embedded in main target 'Zerox1'."

# ── 7. Save ───────────────────────────────────────────────────────────────────

project.save
puts ""
puts "Done! project.pbxproj updated."
puts ""
puts "Next steps:"
puts "  1. Open Zerox1.xcodeproj in Xcode."
puts "  2. Select the 'AgentLiveActivity' target → Signing & Capabilities."
puts "  3. Set Team + enable 'App Groups' → add 'group.world.zerox1.pilot'."
puts "  4. Build (Cmd+B) — both targets must compile."
puts "  5. Run on a real iPhone 14 Pro or newer (Dynamic Island hardware)."
