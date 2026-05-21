# USB Cellular Tether

This folder contains a non-root Android USB cellular tethering proof of concept that is being built as an independent PdaNet-like tool.

The Android app runs a loopback HTTP proxy on the phone. Proxy Mode points Windows proxy settings at it, while Network Adapter Mode creates a Windows virtual adapter and runs a bundled tun2socks engine that forwards adapter traffic through the same phone proxy over USB.

## Projects

- `android` - Kotlin Android app with a foreground proxy service.
- `windows` - C#/.NET Windows companion that manages ADB forwarding, Windows proxy settings, and virtual adapter mode.
- `windows.tests` - dependency-free console tests for focused Windows helper logic.

## Android App

Open `android` in Android Studio, build the app, and install it on the phone. Start the app, tap `Start Tether`, and leave the foreground service running.

The app listens on `127.0.0.1:28080` on the phone for Proxy Mode. It supports HTTP proxy traffic and HTTPS through `CONNECT`. When a cellular network is available, outbound sockets are opened through Android's cellular network socket factory.

Network Adapter Mode uses the same phone proxy and does not require Android VPN permission for internet forwarding. It creates the virtual adapter on Windows and forwards adapter traffic through `tun2socks -> 127.0.0.1:18080 -> ADB -> phone proxy`.

## Windows Companion

Install Android platform-tools so `adb.exe` is on `PATH`, or place `adb.exe` in a `platform-tools` folder next to the built Windows executable.

Run:

```powershell
dotnet run --project .\windows\UsbCellularTether.Windows.csproj
```

The companion opens a small Windows UI with Start/Stop controls, mode selection, device status, tunnel status, proxy status, and a connection log.

Proxy Mode will:

- Wait for an authorized USB debugging device.
- Create `adb forward tcp:18080 tcp:28080`.
- Set the Windows system proxy to `127.0.0.1:18080`.
- Monitor for disconnects and restore the previous proxy settings on stop.

Network Adapter Mode will:

- Copy the bundled `native/amd64/wintun.dll` and `native/amd64/tun2socks.exe` next to the Windows companion executable during build.
- Create/open a Wintun adapter named `wintun`.
- Configure the adapter and run `tun2socks` against the Android HTTP proxy forwarded over USB.
- Add a default route through the virtual adapter and remove it on stop.

Click `Stop` or close the window to stop and restore proxy settings.

## Tests

Run the focused Windows helper tests with:

```powershell
dotnet run --project .\windows.tests\UsbCellularTether.Windows.Tests.csproj
```

Build Android with:

```powershell
gradle -p .\android assembleDebug
```

## Current Limitations

- Requires USB debugging and ADB.
- Proxy Mode uses Windows system proxy settings, so apps that ignore system proxy settings may not use the tether.
- Network Adapter Mode creates a real Windows adapter, but it requires administrator-level route configuration and Wintun driver/runtime support.
- Network Adapter Mode uses tun2socks as the userspace TCP/IP forwarding engine. Without that engine, a virtual adapter can appear but will not have internet access.
