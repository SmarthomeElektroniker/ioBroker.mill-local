# Older changes

Versions before the first public release 0.2.0. They were only used on the author's own system and
were never published to npm.

### 0.1.4 (2026-10-23)

- README: the device only asks for the time after a successful ping to `4.2.2.1`; fully local setup without
  internet access verified (weekly program switches on time).

### 0.1.3 (2026-10-18)

- ON always switches on in the manual mode `Switch` (relay closed), OFF always switches off (`Switch`: relay
  open, otherwise `Off`); `control.power` shows the relay. `status.heating` removed (same as `control.power`).
- Weekly program, one-off timers and vacation readable and writable as JSON, with validation.
- New option: the device's time zone follows the ioBroker host (needed for the timers).

### 0.1.2 (2026-10-18)

- No value is shown twice: the duplicates under `status` (operation mode, target temperature, lock, open window
  enabled) and `settings.temperatureNormal` are gone; obsolete states are removed on start.
- Everything the local API can change is writable: `settings.*` (calibration, locks, display unit, predictive
  heating, cloud, hysteresis, preset temperatures, open window parameters, power level, socket mode, time zone,
  controller type, commercial lock limits, PID), `info.customName` and `control.restart`; every value is
  validated before sending. `status.switchedOn` and `settings.weeklyProgramActive` are gone (misleading / same
  as the operation mode).
- New operation mode `Switch`: plain switch without temperature control, on/off switches the relay directly.
- Object names in all eleven languages.
- Display unit Fahrenheit is sent in the spelling the device accepts.
- Fix: a poll that was running while a command arrived could turn the state back to the old value.
- `status.heating` follows the control signal (relay), also when nothing is plugged in.

### 0.1.1 (2026-10-18)

- Control is now enabled by default (a thermostat is meant to be controlled); it can still be switched off.

### 0.1.0 (2026-10-18)

- First version: all Mill Generation 3 devices with local API, several devices per instance, kind detection,
  network search and re-discovery, control that can be switched off, estimated energy, API key support.
