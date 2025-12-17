https://img.shields.io/github/downloads/shradee/foundry-tube/total

# Foundry Tube 📺

A compact, feature-rich, and synchronized YouTube player for Foundry VTT. 

Foundry Tube allows GMs to play music, ambience, or videos from YouTube directly within the VTT. It features a modern, dark UI, a robust playlist system, preset management, and synchronized playback states for all connected players.

## Features

*   **Synchronized Playback:** Play, Pause, Seek, and Loop states are synced instantly between GM and players.
*   **Compact UI:** 
    *   **Standard Mode:** Full video player with controls.
    *   **Mini Mode:** Double-click the header (or drag-handle) to collapse the player into a slim, 50px control bar that stays out of your way.
*   **Smart Search & Import:**
    *   Paste a direct YouTube link.
    *   Paste a **YouTube Playlist** link to import all videos at once.
    *   Type a search query to find videos directly inside Foundry (no API key required).
*   **Playlist Management:**
    *   **Drag & Drop:** Reorder tracks in the queue by dragging them.
    *   **Presets:** Save your current queue as a preset (e.g., "Battle Music", "Tavern Ambience") and load it later instantly.
*   **Seamless Marquee:** Long video titles scroll automatically and seamlessly in the interface.
*   **Loop Mode:** Repeat the current track indefinitely.

## Installation

1.  Copy the Manifest URL: `https://github.com/shradee/foundry-tube/releases/latest/download/module.json`
2.  Open Foundry VTT -> **Add-on Modules** -> **Install Module**.
3.  Paste the URL and click **Install**.

## Usage

### For GMs
1.  Open the **Token Controls** (left sidebar) and click the **TV Icon** to open the widget.
2.  Click the **+** button to open the input bar.
3.  Paste a link or type a search term and press Enter.
4.  Use the **List Icon** to view the queue.
    *   **Drag** items to reorder.
    *   **Save** the current queue using the Save icon in the preset toolbar.
5.  Double-click the very top edge (drag handle) to minimize/maximize the player.

### For Players
*   The video will play automatically when the GM starts it.
*   You can adjust your own **Local Volume** using the slider on the right.
*   The window can be moved or minimized locally.

## Technical Details
*   This module uses the standard YouTube IFrame API.
*   Search functionality utilizes a CORS proxy to scrape results without requiring a personal Google API Key.

## License
GNU GENERAL PUBLIC LICENSE
