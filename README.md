# AnRRgm Client

AnRRgm Client **3.2.1** is a Gimkit userscript for Tampermonkey. It extends the original Zyrox Client with movement modules for **Don't Look Down**, while keeping its module menu, keybinds, themes, and existing utilities.

[Install userscript](https://raw.githubusercontent.com/AidenRTRRgfdm/AnRRgm-Client/main/AnRRgm-Client.user.js) · [View source](./AnRRgm-Client.user.js)

## Install or update

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Open the userscript link above and choose **Install** when Tampermonkey opens it.
3. If the browser shows JavaScript instead, open Tampermonkey's dashboard, create a new script, and replace its template with the complete contents of [AnRRgm-Client.user.js](./AnRRgm-Client.user.js). Save the script.
4. Disable any separately installed original Zyrox script so two clients do not run together.
5. Refresh [Gimkit Join](https://www.gimkit.com/join) and join a game.

To update manually, replace the code in your existing **AnRRgm Client** script with the latest file and save, then refresh Gimkit. The original Zyrox automatic update links have been removed from this fork.

## Menu controls

- Press **backslash (`\`)** to show or hide the menu.
- **Left-click** a module to toggle it.
- **Right-click** a module to change its settings or assign a keybind.
- Close the menu before using movement. Movement pauses while a client menu, text field, or input-blocking game screen is open, or the game tab is unfocused.

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

## Credits and license

Based on [Zyrox Client](https://github.com/Zyrox-client/Zyrox-gimkit-client), originally authored by **Zyrox client**. AnRRgm Client adds its own branding and the Don't Look Down movement modules. Original author attribution and the upstream MIT copyright notice are retained.

Licensed under the [MIT License](./LICENSE). This project is independently maintained and is not affiliated with Gimkit.
