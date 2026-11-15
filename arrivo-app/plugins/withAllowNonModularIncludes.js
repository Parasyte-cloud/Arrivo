// Lets react-native-maps compile alongside use_frameworks!.
//
// Firebase and the Stream WebRTC SDK need `useFrameworks: "static"`, which is
// set in expo-build-properties. Under frameworks, Xcode turns
// "include of non-modular header inside framework module" from a warning into
// an error, and react-native-maps includes React-Core headers exactly that way
// in about twenty files. The build dies with "too many errors emitted".
//
// Nothing is wrong with the code. The flag below is the same one Xcode shows
// as "Allow Non-modular Includes In Framework Modules", and it is the standard
// answer for this combination. It is applied to the Pods project only, so our
// own target keeps the stricter default.
//
// The Podfile only exists on a Mac (prebuild refuses to generate iOS projects
// on Windows), so the string surgery lives in its own exported function with a
// test next to it. Run: node plugins/withAllowNonModularIncludes.test.js
//
// The block variable is build_config rather than config on purpose: the
// Podfile already has a `config = use_native_modules!` that
// react_native_post_install uses right after, and shadowing it reads like a
// bug even though Ruby keeps block parameters local.
//
// If react-native-maps ever modularises its headers this can go.

const { withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const SETTING = "CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES";

// Pods whose headers are not module ready. Kept narrow on purpose: turning
// modules off everywhere would slow the build down and hide real problems.
// Where the AirMaps headers actually live, quoted for the Podfile.
const AIRMAPS_HEADERS =
  "'\"$(PODS_ROOT)/../../node_modules/react-native-maps/ios/AirMaps\"'";

// Matches the opening line of the post_install block Expo's template always
// generates. Tolerant about spacing and line endings so a template tweak does
// not silently stop this applying.
const POST_INSTALL = /([ \t]*)post_install do \|(\w+)\|[ \t]*\r?\n/;

function addFlagToPodfile(contents) {
  if (contents.includes(SETTING)) return contents;

  const match = contents.match(POST_INSTALL);
  if (!match) {
    throw new Error(
      "withAllowNonModularIncludes: no post_install block found in the Podfile, so " +
        "react-native-maps would fail to compile under use_frameworks. The Expo " +
        "Podfile template must have changed."
    );
  }

  const [line, indent, installer] = match;
  const inner = `${indent}  `;

  const snippet =
    `${inner}# Added by plugins/withAllowNonModularIncludes.js, see that file for why.\n` +
    `${inner}${installer}.pods_project.targets.each do |target|\n` +
    `${inner}  target.build_configurations.each do |build_config|\n` +
    `${inner}    build_config.build_settings['${SETTING}'] = 'YES'\n` +
    `${inner}  end\n` +
    `${inner}end\n` +
    // react-native-google-maps imports "AIRMapCoordinate.h" and friends from the
    // react-native-maps pod. Under use_frameworks that quoted import resolves
    // through the react_native_maps FRAMEWORK, which has already absorbed
    // React-Core's RCTViewManager.h textually, so clang reports:
    //
    //   declaration of 'RCTViewManager' must be imported from module
    //   'react_native_maps.AIRMapCalloutManager' before it is required
    //
    // Pointing the target at the real source directory lets those imports
    // resolve as ordinary files, so RCTViewManager stays React-Core's.
    // Do NOT reach for CLANG_ENABLE_MODULES = NO here: Google-Maps-iOS-Utils
    // uses @import and stops compiling.
    `${inner}installer.pods_project.targets.each do |target|\n` +
    `${inner}  next unless target.name == 'react-native-google-maps'\n` +
    `${inner}  target.build_configurations.each do |build_config|\n` +
    `${inner}    build_config.build_settings['HEADER_SEARCH_PATHS'] ||= ['$(inherited)']\n` +
    `${inner}    build_config.build_settings['HEADER_SEARCH_PATHS'] = Array(build_config.build_settings['HEADER_SEARCH_PATHS']) + [${AIRMAPS_HEADERS}]\n` +
    `${inner}  end\n` +
    `${inner}end\n` +
    // The header search path alone does not win: with modules on, clang maps a
    // quoted import of a header that lives inside a framework to that framework's
    // module, whatever the search order. So stop react-native-maps advertising a
    // module at all. Its headers are then plain files, RCTViewManager stays
    // React-Core's, and modules remain enabled everywhere else, which is what
    // Google-Maps-iOS-Utils needs for its @import.
    `${inner}installer.pods_project.targets.each do |target|\n` +
    `${inner}  next unless target.name == 'react-native-maps'\n` +
    `${inner}  target.build_configurations.each do |build_config|\n` +
    `${inner}    build_config.build_settings['DEFINES_MODULE'] = 'NO'\n` +
    `${inner}  end\n` +
    `${inner}end\n`;

  return contents.replace(line, line + snippet);
}

function withAllowNonModularIncludes(config) {
  return withDangerousMod(config, [
    "ios",
    (cfg) => {
      const podfile = path.join(cfg.modRequest.platformProjectRoot, "Podfile");
      fs.writeFileSync(podfile, addFlagToPodfile(fs.readFileSync(podfile, "utf8")));
      return cfg;
    },
  ]);
}

module.exports = withAllowNonModularIncludes;
module.exports.addFlagToPodfile = addFlagToPodfile;
module.exports.SETTING = SETTING;
