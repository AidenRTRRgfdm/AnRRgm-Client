# AnRRgm Client

AnRRgm Client **3.2.2** is a Gimkit userscript for Tampermonkey with combat tools, movement modules for **Don't Look Down**, configurable keybinds, themes, and other utilities.

[Install userscript](https://raw.githubusercontent.com/AidenRTRRgfdm/AnRRgm-Client/main/AnRRgm-Client.user.js) · [View source](./AnRRgm-Client.user.js)

## Install or update

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Open the userscript link above and choose **Install** when Tampermonkey opens it.
3. If the browser shows JavaScript instead, open Tampermonkey's dashboard, create a new script, and replace its template with the complete contents of [AnRRgm-Client.user.js](./AnRRgm-Client.user.js). Save the script.
4. Disable any duplicate or older Gimkit client scripts so two clients do not run together.
5. Refresh [Gimkit Join](https://www.gimkit.com/join) and join a game.

To update manually, replace the code in your existing **AnRRgm Client** script with the latest file and save, then refresh Gimkit.

## Menu controls

- Press **backslash (`\`)** to show or hide the menu.
- **Left-click** a module to toggle it.
- **Right-click** a module to change its settings or assign a keybind.
- Close the menu before using movement. Movement pauses while a client menu, text field, or input-blocking game screen is open, or the game tab is unfocused.

## Combat modules

Open the **Combat** panel, left-click a module to enable it, and right-click it for settings. Each module can have a toggle keybind or a keybind that enables it only while held. The Crosshair module can stay off while the other combat tools run.

| Module | Controls and settings |
| --- | --- |
| **Crosshair** | Draws at the game cursor and hides the normal page cursor while enabled. Defaults: red diagonal X, 25 px size, 4 px width; player-hover highlight is yellow and enabled. Choose other shapes, colors, sizes, or a line from the screen center to the cursor. Press **Escape** to disable it when client menus are closed and pointer lock is released. |
| **Triggerbot (Autoshoot)** | Automatically clicks while the cursor is inside another player's projected hitbox; no manual mouse hold is required. Defaults: ignore teammates, require game focus, show target ring, and a 16 ms minimum click interval. **Hold Fire While Targeted** simulates holding the fire button instead of repeated clicks. |
| **Quick Fire** | Repeatedly requests shots toward the game cursor while you hold the left mouse button. **Always fire** removes the mouse-hold requirement. Defaults: 5 ms interval, Always fire off, and Only When Focused on. The interval range is 0–250 ms; 0 ms still uses the client's burst and rate limits. Actual weapon fire remains controlled by the game and server. |
| **Aimbot** | Moves the game's aim toward the eligible player closest to the cursor. Defaults: 180° Aim FOV, ignore teammates, require game focus, smoothing 0, maximum step 120 px, and target debug dot on. **Require Left Mouse** limits aiming to when you hold left click. It does not fire automatically by itself; click manually or combine it with a firing module. |

Triggerbot and Aimbot need compatible live player and camera data. They exclude your own character; teammate filtering depends on available team data. Quick Fire needs the live game socket, player position, and game pointer. Their **Only When Focused** setting is enabled by default; combat automation does not share movement's general menu/input pause, so turn it off when you need it to stop.

Triggerbot's current **FOV Radius** setting changes its visual ring; target detection uses the projected player hitbox. **Require LOS (future)** currently performs no line-of-sight check. Aimbot also has no line-of-sight filter. Its FOV measures the angle from the cursor's recent movement direction rather than a fixed circle around the player.

Aimbot offers smoothing, step limits, prediction, deadzone, and target-lock controls. In this version, setting Prediction, Target Lock, or Deadzone to 0 still uses fallback values of 70 ms, 220 ms, and 1.8 px respectively; Min Step 0 has a 0.05 px floor.

## Don't Look Down modules

| Module | Controls and settings |
| --- | --- |
| **Fly** | Move with WASD or arrows. Space rises; Shift descends. Flight speed is adjustable from 20 to 700 px/s; default 310 px/s. |
| **Noclip** | Free flight through solid terrain with WASD/arrows, Space, and Shift. Speed is adjustable from 20 to 700 px/s; default 60 px/s. It also lets Short TP pass through walls. Disable Noclip to restore normal collision filtering. |
| **Speed** | Multiply horizontal movement from 1× to 4×; default 1.6×. |
| **High Jump** | Multiply the local jump force from 1× to 4×; default 1.8×. Jump with W, Up, or Space. |
| **Air Jump** | Release and press the jump key again to jump while airborne. |
| **Short TP** | Enable the module, then tap **B**. Distance is adjustable from 5 to 150 pixels; default 25 pixels. Choose facing, up, down, left, or right. Cooldown is adjustable from 0 to 2500 ms; default 0 ms. Release B between taps. Collisions limit the blink unless Noclip is enabled. |

The module keybind toggles Short TP; **B** triggers the blink while it is enabled. Movement uses the active platformer character and waits when compatible game physics are unavailable.

## Local movement and server corrections

These modules change client-side physics. Gimkit's server can correct the player back to its authoritative position. Flight, Noclip, speed boosts, higher jumps, and teleports are therefore not guaranteed to persist on the server.

Local testing observed a 5-pixel blink remain in place for several seconds, while 25- and 80-pixel blinks and boosted movement were corrected. This observation does not guarantee that future movement will be accepted. The client displays a message when it detects a significant server correction.

Gimkit updates can change its private game internals and break compatibility. Turn off the movement modules to restore their hooked input, collision, and server-position methods. Refresh the page if game state remains out of sync.

Licensed under the [MIT License](./LICENSE). This project is independently maintained and is not affiliated with Gimkit.
