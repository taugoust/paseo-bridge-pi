{
  description = "Composable Pi/Paseo bridge artifacts and integration modules";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }: {
    lib.mkBridge = import ./nix/mk-bridge.nix;
    nixosModules.default = import ./nix/nixos.nix;
    homeManagerModules.default = import ./nix/home-manager.nix;
    checks = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ] (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        subagent-routing = pkgs.runCommand "paseo-subagent-routing" { nativeBuildInputs = [ pkgs.nodejs_24 ]; } ''
          export HOME="$TMPDIR/home"
          mkdir -p "$HOME"
          cp -r ${self} source
          chmod -R u+w source
          cd source
          node --experimental-strip-types --test --test-timeout=30000 \
            test/subagent-routing-context.test.mjs \
            test/subagent-routing-operator.test.ts \
            test/subagent-routing-transport.integration.test.ts \
            plugin/test/subagent-routing-transport.test.ts \
            test/account-controls-context.test.mjs \
            test/account-controls-operator.test.ts \
            test/account-controls-transport.integration.test.ts \
            plugin/test/account-controls-transport.test.ts
          touch "$out"
        '';
        pure-helpers = import ./nix/checks.nix {
          inherit pkgs;
          src = self;
          package = self.packages.${system}.default;
        };
      }
    );
    packages =
      nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ]
        (
          system:
          let
            pkgs = import nixpkgs { inherit system; };
          in
          {
            default = pkgs.callPackage ./nix/package.nix { src = self; };
            paseo-bridge-pi = self.packages.${system}.default;
          }
        );
  };
}
