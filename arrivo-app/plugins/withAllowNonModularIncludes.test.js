// Tests for the Podfile patch. Run directly:
//   node plugins/withAllowNonModularIncludes.test.js
//
// The Podfile itself only exists on a Mac, so this checks the string surgery
// against a copy of what Expo's SDK 54 template actually generates. If the
// build starts failing on react-native-maps headers again, check here first:
// a template change that moves post_install is exactly what would break it.

const assert = require("assert");
const { addFlagToPodfile, SETTING } = require("./withAllowNonModularIncludes");

// Trimmed from a real SDK 54 managed Podfile. The post_install block and its
// two space indent are the parts that matter.
const PODFILE = `require File.join(File.dirname(\`node --print "require.resolve('expo/package.json')"\`), "scripts/autolinking")
require File.join(File.dirname(\`node --print "require.resolve('react-native/package.json')"\`), "scripts/react_native_pods")

platform :ios, podfile_properties['ios.deploymentTarget'] || '15.1'
install! 'cocoapods', :deterministic_uuids => false

target 'RideArrivo' do
  use_expo_modules!
  config = use_native_modules!

  use_frameworks! :linkage => podfile_properties['ios.useFrameworks'].to_sym if podfile_properties['ios.useFrameworks']

  post_install do |installer|
    react_native_post_install(
      installer,
      config[:reactNativePath],
      :mac_catalyst_enabled => false,
      :ccache_enabled => podfile_properties['apple.ccacheEnabled'] == 'true',
    )
  end

  post_integrate do |installer|
    begin
      expo_patch_react_imports!(installer)
    rescue => e
      Pod::UI.warn e
    end
  end
end
`;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${e.message}`);
    process.exitCode = 1;
  }
}

test("the flag is added inside the post_install block", () => {
  const out = addFlagToPodfile(PODFILE);
  assert.ok(out.includes(SETTING), "the setting should be present");

  const start = out.indexOf("post_install do |installer|");
  const end = out.indexOf("post_integrate do |installer|");
  const inside = out.slice(start, end);
  assert.ok(inside.includes(SETTING), "must land inside post_install, not after it");
  assert.ok(inside.includes("installer.pods_project.targets.each"), "should loop the Pods targets");
});

test("the existing post_install body is kept", () => {
  const out = addFlagToPodfile(PODFILE);
  assert.ok(out.includes("react_native_post_install("), "must not replace what was already there");
  assert.ok(out.includes(":ccache_enabled =>"), "the rest of the call should survive");
  assert.ok(out.includes("post_integrate do |installer|"), "later blocks should be untouched");
});

test("the google maps target gets the AirMaps headers on its search path", () => {
  // Without this, react-native-google-maps imports AIRMapCoordinate.h through the
  // react_native_maps framework module, which has already absorbed RCTViewManager.
  const out = addFlagToPodfile(PODFILE);
  assert.ok(out.includes("next unless target.name == 'react-native-google-maps'"), "only that target");
  assert.ok(out.includes("node_modules/react-native-maps/ios/AirMaps"), "should point at the AirMaps sources");
  assert.ok(out.includes("HEADER_SEARCH_PATHS"), "should extend the header search path");
  assert.ok(out.includes("$(inherited)"), "must not drop the inherited paths");
});

test("react-native-maps stops advertising a module", () => {
  const out = addFlagToPodfile(PODFILE);
  assert.ok(out.includes("DEFINES_MODULE'] = 'NO'"), "the maps pod must not define a module");
  assert.ok(out.includes("next unless target.name == 'react-native-maps'"), "and only that pod");
});

test("modules are never disabled", () => {
  // Tried that. Google-Maps-iOS-Utils uses @import and the build dies with
  // "use of @import when modules are disabled".
  const out = addFlagToPodfile(PODFILE);
  assert.ok(!out.includes("CLANG_ENABLE_MODULES"), "leave modules alone");
});

test("running twice changes nothing the second time", () => {
  const once = addFlagToPodfile(PODFILE);
  assert.strictEqual(addFlagToPodfile(once), once, "prebuild can run repeatedly, this must be idempotent");
  assert.strictEqual(once.split(SETTING).length - 1, 1, "the flag should appear exactly once");
});

test("the Podfile's own config variable is not shadowed", () => {
  // react_native_post_install uses `config` on the next line. Reusing the name
  // as our block parameter would read like a bug to the next person.
  const out = addFlagToPodfile(PODFILE);
  assert.ok(out.includes("do |build_config|"), "should use its own block variable name");
  assert.ok(!out.includes("each do |config|"), "must not shadow the Podfile's config");
});

test("the installer variable name is followed, not assumed", () => {
  const renamed = PODFILE.replace("post_install do |installer|", "post_install do |inst|");
  const out = addFlagToPodfile(renamed);
  assert.ok(out.includes("inst.pods_project.targets.each"), "should use the block's own variable");
});

test("windows line endings still match", () => {
  const out = addFlagToPodfile(PODFILE.replace(/\n/g, "\r\n"));
  assert.ok(out.includes(SETTING), "a CRLF Podfile should still be patched");
});

test("a Podfile with no post_install fails loudly", () => {
  // Silently doing nothing would mean the build fails on Xcode errors much
  // later, with nothing pointing back here.
  assert.throws(
    () => addFlagToPodfile("target 'RideArrivo' do\n  use_expo_modules!\nend\n"),
    /post_install/,
    "should refuse rather than return the Podfile unchanged"
  );
});

console.log(`\n${passed} passed`);
