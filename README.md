# 🔗 Pi ↔ Paseo

[![Pi](https://img.shields.io/badge/Pi-1.x-blue)](https://pi.dev) [![Paseo](https://img.shields.io/badge/Paseo-0.11.4%2B-purple)](https://paseo.sh) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](package.json)

**One live conversation. Terminal and Paseo.**

Keep working in Pi while Paseo streams the conversation, sends messages and controls the model.
Add the optional plugin for Goals, jobs, agents and accounts.

[Nix setup](nix/README.md) · [Plugin guide](plugin/README.md) · [Full reference](docs/reference.md)

## 📦 Choose the components

| Component | Use it for |
| --- | --- |
| [Pi extension](extension) | Attach the live terminal conversation to Paseo. |
| [Provider shim](shim) | Route native Paseo RPC to the owning Pi session. |
| [Paseo plugin](plugin/README.md) | Add Work, Goals, jobs, agents and account controls. |
| [Nix integration](nix/README.md) | Compose packages, trusted launchers and configuration. |

## 🚀 Start with Nix

```nix
inputs.paseo-bridge-pi = {
  url = "github:taugoust/paseo-bridge-pi";
  inputs.nixpkgs.follows = "nixpkgs";
};
```

Import the Home Manager or NixOS module and configure `programs.paseo-bridge-pi`.
Your host supplies endpoints, trusted launchers and secret-file references; the package assembles the wrappers.

**[Complete configuration example →](nix/README.md)**

<details>
<summary>Install without Nix</summary>

```sh
pi install git:github.com/taugoust/paseo-bridge-pi
```

Run `/paseo-bridge install` against writable native Paseo configuration, then restart the daemon. Use the Nix integration for declaratively managed configuration instead.

Install the optional plugin separately:

```sh
paseo plugin install github:taugoust/paseo-bridge-pi --path plugin
```

Requires Pi 1.x and Node 22+. The plugin requires Paseo 0.11.4+; advanced controls may also need matching Pi extensions and server patches.

</details>

## 🎛️ Everyday controls

| Command | Action |
| --- | --- |
| `/paseo-bridge status` | Inspect the connection. |
| `/paseo-bridge connect` / `disconnect` | Attach or detach this session. |
| `/paseo-bridge auto on` / `off` | Set the auto-connect preference. |
| `/remote-reload` | Reload Pi resources while idle, including from Paseo. |

## 📚 Go further

| Topic | Guide |
| --- | --- |
| Packages, modules and the pure Nix constructor | [Nix API](nix/README.md) |
| Commands, environment and reload behavior | [Reference](docs/reference.md) |
| Permissions, private sockets and account controls | [Plugin guide](plugin/README.md) |
| Pi tools and workflows | [pi-agent-extensions](https://github.com/taugoust/pi-agent-extensions) |

> [!IMPORTANT]
> A server update does not update built-in desktop/mobile UI. Supervised forks stay supervised; credentials and control capabilities remain private runtime state.

## 📄 License

MIT; see [package metadata](package.json). Adapted Paseo UI sources retain their Apache-2.0 notices.
