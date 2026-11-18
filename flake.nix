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
        subagent-routing = import ./nix/subagent-routing-check.nix {
          inherit pkgs;
          src = self;
        };
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
