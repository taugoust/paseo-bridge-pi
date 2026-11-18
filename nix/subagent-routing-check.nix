{ pkgs, src }:
pkgs.runCommand "paseo-subagent-routing" { nativeBuildInputs = [ pkgs.nodejs_24 ]; } ''
  bash ${./subagent-routing-check.sh} ${src}
  touch $out
''
