<p align="center">
    <img width="2400" height="1260" alt="banner" src="https://github.com/user-attachments/assets/9961141a-735d-4767-940a-73ec1cda97a1" />
  <img src="https://github.com/miguelpadillax/box-sigma/blob/master/app/src/main/res/drawable/autopip_demo.gif" />
</p>

 <p align="center">
   Smart Picture-in-Picture for YouTube tabs.<br />
   Leave the tab, keep watching. Come back, PiP closes automatically.
 </p>


## 🚀 Features

 | Feature | What it does |
 |---|---|
 | Auto PiP | Enters PiP when you leave YouTube and conditions are met. See [limitations](#known-limitations) |
 | Smart Gate | Requests a valid user interaction only when required |
 | Auto Exit | Closes PiP when you return to YouTube |
 | Speed Control | Set speed from popup or media actions |
 | Remember Speed | Restores your preferred speed on next videos |


## 🧩 Popup Settings

- Auto PiP: Enables or disables automatic PiP behavior.
- Remember playback speed: Stores last selected speed and restores it on next videos.
- Allow PiP when paused: Allows PiP to trigger even if video is paused.
- Playback speed grid: 0.5x, 0.75x, 1x, 1.25x, 1.5x, 1.75x, 2x, 2.5x.
- Reset app data: Clears local storage and restores defaults.

## ⚙️ How it works?

1. User is on YouTube.
2. If tab becomes hidden and conditions match, extension tries to enter PiP.
3. If no trusted interaction is available, an interaction gate is shown in YouTube. See [limitations](#known-limitations).
4. If user confirms gate and PiP activates, extension switches to destination tab.
5. Returning to YouTube exits PiP and resets interaction state for the next cycle.

## 🛡️ Interaction Gate

- Triggered when leaving YouTube without a qualifying user interaction.
- User can confirm (enable PiP and continue) or cancel (continue without PiP).
- Cancel path temporarily bypasses repeated prompting for the same destination tab.

## 🔧 Installation

You can install the extension using one of these options:

#### A) Chrome Web Store (Recommended)

- Install from [Chrome Web Store](https://chromewebstore.google.com/detail/autopip-enhanced/ldkdoddjjgknhokdbpbpipekodnpjfok).

#### B) Developer Mode

-  Open `chrome://extensions`.
- Enable Developer mode.
- Click Load unpacked.
- Select this project folder.

## 🔐 Permissions

- `tabs`: Detect activation changes and navigate between source/destination tabs.
- `storage`: Persist settings, language, and last speed.
- `scripting`: Probe tab state (video presence/playing fallback checks).
- `activeTab`: Access current active tab context used by popup actions.

<a id="known-limitations"></a>
## ⚠️ Known Limitations

- PiP activation is restricted by browser user-gesture policies (basically a click, keypress or any other interaction with the website). If no valid interaction happened on YouTube yet, the extension shows an interaction gate; confirming it provides the required gesture so PiP can start.
- Behavior may vary on YouTube layouts that do not expose the expected video element.
- Speed commands from popup apply only when active tab is YouTube and content script is reachable.
