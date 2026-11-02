{
  pkgs,
  package,
  src,
}:
let
  # Only explicit pure-helper suites: no installed providers, accounts, tmux,
  # live sessions, network, daemon or service manager is used by this check.
  nodejs = pkgs.nodejs_24;
  peer = pkgs.writeShellScript "bridge-config-rpc-peer" ''
    exec ${nodejs}/bin/node ${src}/test/fixtures/config-rpc-peer.mjs "$@"
  '';
  args = {
    inherit pkgs package nodejs;
    paseoPackage = "/fixture/paseo";
    rootTrustMode = "supervised";
    supervisedLauncher = "/fixture/supervised";
    unsafeLauncher = "/fixture/unsafe";
    rpcExecutable = toString peer;
    permissionGateExtension = "/fixture/permission gate.ts";
    rpcExtensions = [
      "/fixture/provider's extension.ts"
      "/fixture/permission gate.ts"
    ];
    autoConnect = false;
    importSessions = false;
    host = "host with 'quotes' and $dollars";
    passwordFile = "/run/secrets/paseo password";
  };
  mk = overrides: import ./mk-bridge.nix (args // overrides);
  bridge = mk { };
  fails =
    overrides: field: !(builtins.tryEval (builtins.deepSeq (mk overrides).${field} true)).success;
  valid =
    assert bridge.environment.PI_PASEO_BRIDGE_DEFAULT_AUTO_CONNECT == "0";
    assert bridge.shimEnvironment.PI_PASEO_ROOT_TUI_KIND == "supervised";
    assert bridge.pluginSettings.paseo-permission-gate.path == "${package}/plugin";
    assert fails { passwordFile = "/nix/store/secret"; } "environment";
    assert fails { passwordFile = "relative"; } "environment";
    assert fails { rootTrustMode = "implicit"; } "shimEnvironment";
    assert fails { topology = true; } "shimEnvironment";
    assert fails { supervisedLauncher = "relative"; } "shimEnvironment";
    assert fails { startTimeoutMs = 999; } "shimEnvironment";
    assert fails { startTimeoutMs = 600001; } "shimEnvironment";
    assert fails { rpcExtensions = null; } "rpcPackage";
    assert fails { rpcExecutable = "pi"; } "rpcPackage";
    assert fails { rpcExtensions = [ "relative.ts" ]; } "rpcPackage";
    true;
in
assert valid;
pkgs.runCommand "paseo-bridge-pi-pure-helpers" { nativeBuildInputs = [ nodejs ]; } ''
  export HOME="$TMPDIR/home"
  mkdir -p "$HOME"
  cp -r ${src} source
  chmod -R u+w source
  cd source
  export BRIDGE_CHECK_PACKAGE=${package}
  export BRIDGE_CHECK_RPC=${bridge.rpcPackage}/bin/pi-paseo
  node --experimental-strip-types --test --test-timeout=30000 \
    test/bridge-settings.test.ts test/abort-dispatch.test.ts \
    test/canonical-name-sync.test.ts test/paseo-ws.test.ts \
    test/idle-preflight.test.ts test/packaging-check.test.mjs \
    test/compaction-command.test.ts test/remote-user-content.test.ts \
    test/session-projection.test.ts test/prompt-dispatch.test.ts \
    test/session-model-request.test.ts test/import-placement.test.ts \
    test/subagent-task-projection.test.ts test/subagent-native-projection.test.ts \
    test/native-subagent-links.test.ts plugin/test/jobs-pages.test.ts plugin/test/agent-directory.test.ts \
    plugin/test/native-code-model.test.ts plugin/test/native-tool-details.test.ts plugin/test/native-truncated-result.test.ts \
    plugin/test/private-account-json.test.ts \
    plugin/test/worktree-checkout-stats.test.ts plugin/test/worktree-diff-stats.test.ts
  touch "$out"
''
