const MODULE_ID = 'foundry-tube';
const SOCKET_NAME = `module.${MODULE_ID}`;
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const PROXY_URL = (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`;

class FoundryTubeApp extends HandlebarsApplicationMixin(ApplicationV2) {
    constructor() {
        super();
        window.tubeApp = this;
        this.player = null;
        this.isCustomMinimized = false;
        this.isLooping = false;
        this.isInputMode = false;
        this.playlist = [];
        this.currentIndex = -1;
        this.localVideoId = "";
        this.savedHeight = 320;
        this.savedWidth = 580;
        this.progressInterval = null;
        this._resizeObserver = null;
    }

    static DEFAULT_OPTIONS = {
        id: "foundry-tube-app", tag: "div",
        window: { title: "Tube", icon: "fas fa-tv", resizable: true, minimizable: true, controls: [] },
        position: { width: 580, height: 320, top: 100, left: 115 },
        actions: {
            togglePlayback: FoundryTubeApp.prototype._onTogglePlayback,
            toggleLoop: FoundryTubeApp.prototype._onToggleLoop,
            toggleInputMode: FoundryTubeApp.prototype._onToggleInputMode,
            executeSmartInput: FoundryTubeApp.prototype._onExecuteSmartInput,
            toggleQueue: FoundryTubeApp.prototype._onToggleQueue,
            clearQueue: FoundryTubeApp.prototype._onClearQueue,
            playNext: FoundryTubeApp.prototype._onPlayNextAction,
            playPrev: FoundryTubeApp.prototype._onPlayPrevAction,
            closeSearch: FoundryTubeApp.prototype._onCloseSearch,
            savePreset: FoundryTubeApp.prototype._onSavePreset,
            loadPreset: FoundryTubeApp.prototype._onLoadPreset,
            deletePreset: FoundryTubeApp.prototype._onDeletePreset,
            importFromClipboard: FoundryTubeApp.prototype._onImportFromClipboard
        }
    };

    static PARTS = { main: { template: `modules/${MODULE_ID}/templates/widget.hbs` } };

    async minimize() {
        this.isCustomMinimized = !this.isCustomMinimized;
        if (this.isCustomMinimized) {
            const rect = this.element.getBoundingClientRect();
            this.savedWidth = rect.width;
            this.savedHeight = rect.height;
            this.element.classList.add('custom-minimized');
            return this.setPosition({ height: 50 });
        } else {
            this.element.classList.remove('custom-minimized');
            const w = parseInt(this.savedWidth) || 580;
            const h = (parseInt(this.savedHeight) > 100) ? parseInt(this.savedHeight) : 320;
            return this.setPosition({ width: w, height: h });
        }
    }

    async close(options={}) {
        if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }
        if (!options.force) return;
        return super.close(options);
    }

    async _prepareContext(options) {
        const currentVideoId = this.localVideoId || game.settings.get(MODULE_ID, 'currentVideoId');
        const volume = game.settings.get(MODULE_ID, 'clientVolume');
        const savedPlaylists = game.settings.get(MODULE_ID, 'savedPlaylists');
        return {
            isGM: game.user.isGM,
            currentUrl: currentVideoId ? `https://www.youtube.com/watch?v=${currentVideoId}` : "",
            volume,
            isLooping: this.isLooping,
            savedPlaylists
        };
    }

    _onRender(context, options) {
        try {
            const appHeader = this.element.closest('.window-app')?.querySelector('.window-header');
            if (appHeader) {
                const newHeader = appHeader.cloneNode(true);
                appHeader.parentNode.replaceChild(newHeader, appHeader);
                newHeader.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); this.minimize(); });
                const t = newHeader.querySelector('.window-title'); if(t) t.innerText = "";
            }

            if (!this._resizeObserver) {
                this._resizeObserver = new ResizeObserver((entries) => {
                    for (const entry of entries) {
                        if (this.isCustomMinimized) this.position.width = entry.contentRect.width;
                    }
                });
                this._resizeObserver.observe(this.element);
            }

            if (!this.localVideoId) this.localVideoId = game.settings.get(MODULE_ID, 'currentVideoId');
            const savedList = game.settings.get(MODULE_ID, 'playlist');
            const savedIdx = game.settings.get(MODULE_ID, 'playlistIndex');
            if (savedList) this.playlist = savedList;
            if (typeof savedIdx === 'number') this.currentIndex = savedIdx;

            if (this.localVideoId) this._refreshTitle(this.localVideoId);
            else this.updateTrackTitle("No Video");

            this._renderPlaylist();
            this._tryInitPlayer();

            const smartInp = this.element.querySelector('input[name="smartInput"]');
            if(smartInp) {
                const newInp = smartInp.cloneNode(true);
                smartInp.parentNode.replaceChild(newInp, smartInp);
                newInp.addEventListener('keydown', (e) => { if(e.key === 'Enter') this._onExecuteSmartInput(); });
            }

            const volInput = this.element.querySelector('input[name="volume"]');
            if (volInput) {
                volInput.oninput = (e) => { if (this.player?.setVolume) this.player.setVolume(parseInt(e.target.value)); };
                volInput.onchange = async (e) => { await game.settings.set(MODULE_ID, 'clientVolume', parseInt(e.target.value)); };
            }
            const seeker = this.element.querySelector('.video-seeker');
            if (seeker && game.user.isGM) {
                seeker.onchange = () => {
                    const val = parseFloat(seeker.value);
                    if (this.player?.seekTo) { this.player.seekTo(val, true); this.emitSocket("play", { time: val }); }
                };
            }

            if (this.isCustomMinimized) {
                this.element.classList.add('custom-minimized');
                this.setPosition({ height: 50 });
            }
            if (this.isInputMode) {
                const s = this.element.querySelector('#view-seeker');
                const i = this.element.querySelector('#view-input');
                const b = this.element.querySelector('.toggle-mode-btn');
                if(s && i && b) {
                    s.style.display='none'; i.style.display='flex';
                    b.innerHTML = '<i class="fas fa-times"></i>';
                }
            }

        } catch (err) { console.error(err); }
    }

    updateTrackTitle(text) {
        const container = this.element.querySelector('.track-info');
        const el = this.element.querySelector('#track-title-text');
        if (!el || !container) return;
        const safeText = text || "No Video";
        el.classList.remove('scrolling');
        el.style.animationDuration = '0s';
        el.innerHTML = `<span>${safeText}</span>`;
        if (el.scrollWidth > container.clientWidth) {
            const spacer = "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;";
            el.innerHTML = `<span>${safeText}</span><span>${spacer}</span><span>${safeText}</span><span>${spacer}</span>`;
            el.classList.add('scrolling');
            const speed = Math.max(10, el.scrollWidth / 20);
            el.style.animationDuration = `${speed}s`;
        } else {
            el.innerHTML = `<span>${safeText}</span>`;
        }
    }

    async _refreshTitle(videoId) {
        if (!videoId) return;
        const inPlaylist = this.playlist.find(v => v.id === videoId);
        if (inPlaylist && inPlaylist.title && inPlaylist.title !== "Video") {
            this.updateTrackTitle(inPlaylist.title);
            return;
        }
        if (this.player && this.player.getVideoData) {
            const data = this.player.getVideoData();
            if (data && data.title) { this.updateTrackTitle(data.title); return; }
        }
        const meta = await this._fetchMetadata(videoId);
        if (meta && meta.title) this.updateTrackTitle(meta.title);
    }

    async _onSavePreset() {
        if (this.playlist.length === 0) return ui.notifications.warn("Queue is empty!");
        new Dialog({
            title: "Save Preset",
            content: `<form><div class="form-group"><label>Preset Name</label><input type="text" name="name" placeholder="My Playlist"/></div></form>`,
            buttons: {
                save: {
                    label: "Save", icon: "<i class='fas fa-save'></i>",
                    callback: async (html) => {
                        const name = html.find('input[name="name"]').val().trim();
                        if (!name) return;
                        const saved = game.settings.get(MODULE_ID, 'savedPlaylists');
                        saved[name] = this.playlist;
                        await game.settings.set(MODULE_ID, 'savedPlaylists', saved);
                        ui.notifications.info(`Preset "${name}" saved!`);
                        this.render();
                    }
                }
            }
        }).render(true);
    }

    async _onLoadPreset() {
        const select = this.element.querySelector('#preset-select');
        const name = select.value;
        if (!name) return;
        const saved = game.settings.get(MODULE_ID, 'savedPlaylists');
        if (saved[name]) {
            Dialog.confirm({
                title: "Load Preset",
                content: `<p>Replace current queue with "<strong>${name}</strong>"?</p>`,
                yes: async () => {
                    this.playlist = [...saved[name]];
                    this.currentIndex = 0;
                    await this._syncPlaylistState();
                    if(this.playlist.length > 0) {
                        this.broadcastState(this.playlist[0].id, 0, true);
                        this.updateTrackTitle(this.playlist[0].title);
                    }
                }
            });
        }
    }

    async _onDeletePreset() {
        const select = this.element.querySelector('#preset-select');
        const name = select.value;
        if (!name) return;
        Dialog.confirm({
            title: "Delete Preset",
            content: `<p>Delete preset "<strong>${name}</strong>"?</p>`,
            yes: async () => {
                const saved = game.settings.get(MODULE_ID, 'savedPlaylists');
                delete saved[name];
                await game.settings.set(MODULE_ID, 'savedPlaylists', saved);
                ui.notifications.info(`Preset "${name}" deleted.`);
                this.render();
            }
        });
    }

    _onImportFromClipboard() {
        new Dialog({
            title: "Import YouTube Playlist",
            content: `<form><div class="form-group"><label>URL</label><input type="text" name="url" placeholder="https://youtube.com/playlist?list=..."/></div></form>`,
            buttons: {
                import: {
                    label: "Import", icon: "<i class='fab fa-youtube'></i>",
                    callback: async (html) => {
                        const url = html.find('input[name="url"]').val().trim();
                        await this._handleImport(url);
                    }
                }
            }
        }).render(true);
    }

    async playVideoNow(videoData) {
        const insertIdx = this.currentIndex + 1;
        this.playlist.splice(insertIdx, 0, videoData);
        this.currentIndex = insertIdx;
        await this._syncPlaylistState();
        this.broadcastState(videoData.id, 0, true);
        this.updateTrackTitle(videoData.title);
    }

    addToPlaylist(videoData) {
        this.playlist.push(videoData);
        this._syncPlaylistState();
    }

    addMultipleToPlaylist(videos) {
        this.playlist.push(...videos);
        this._syncPlaylistState();
    }

    async playNext() {
        if (this.currentIndex + 1 >= this.playlist.length) return;
        this.currentIndex++;
        await this._syncPlaylistState();
        const v = this.playlist[this.currentIndex];
        this.broadcastState(v.id, 0, true);
        this.updateTrackTitle(v.title);
    }

    async playPrev() {
        if (this.currentIndex <= 0) return;
        this.currentIndex--;
        await this._syncPlaylistState();
        const v = this.playlist[this.currentIndex];
        this.broadcastState(v.id, 0, true);
        this.updateTrackTitle(v.title);
    }

    async _syncPlaylistState() {
        if(game.user.isGM) {
            await game.settings.set(MODULE_ID, 'playlist', this.playlist);
            await game.settings.set(MODULE_ID, 'playlistIndex', this.currentIndex);
            if(this.playlist[this.currentIndex]) {
                await game.settings.set(MODULE_ID, 'currentVideoId', this.playlist[this.currentIndex].id);
            }
            this.emitSocket("syncPlaylist", { playlist: this.playlist, index: this.currentIndex });
        }
        this._renderPlaylist();
    }

    _renderPlaylist() {
        const container = this.element.querySelector('#playlist-container');
        const count = this.element.querySelector('#playlist-count');
        if(count) count.innerText = this.playlist.length;

        if (container) {
            container.innerHTML = this.playlist.length ? '' : '<div class="empty-msg">Playlist is empty</div>';
            this.playlist.forEach((v, i) => {
                const el = document.createElement('div');
                el.className = 'list-item';
                el.dataset.index = i;
                if (i === this.currentIndex) el.classList.add('active-track');
                if (i < this.currentIndex) el.style.opacity = '0.5';
                let btn = game.user.isGM ? `<button class="list-remove"><i class="fas fa-times"></i></button>` : '';
                el.innerHTML = `
                <img src="${v.thumb}" class="list-thumb">
                <div class="list-info">
                <div class="list-title" title="${v.title}">${v.title}</div>
                <div class="list-meta">${v.author} • ${v.duration}</div>
                </div>
                ${btn}
                `;
                if (game.user.isGM) {
                    el.setAttribute('draggable', 'true');
                    el.addEventListener('dragstart', (e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', i); el.classList.add('dragging'); });
                    el.addEventListener('dragend', () => { el.classList.remove('dragging'); container.querySelectorAll('.drag-over').forEach(item => item.classList.remove('drag-over')); });
                    el.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; el.classList.add('drag-over'); });
                    el.addEventListener('dragleave', () => { el.classList.remove('drag-over'); });
                    el.addEventListener('drop', async (e) => {
                        e.preventDefault(); el.classList.remove('drag-over');
                        const fromIndex = parseInt(e.dataTransfer.getData('text/plain'));
                        const toIndex = i;
                        if (fromIndex === toIndex) return;
                        const currentPlayingId = (this.currentIndex >= 0 && this.playlist[this.currentIndex]) ? this.playlist[this.currentIndex].id : null;
                        const movedItem = this.playlist.splice(fromIndex, 1)[0];
                        this.playlist.splice(toIndex, 0, movedItem);
                        if (currentPlayingId) { this.currentIndex = this.playlist.findIndex(x => x.id === currentPlayingId); }
                        else {
                            if (this.currentIndex === fromIndex) this.currentIndex = toIndex;
                            else if (this.currentIndex > fromIndex && this.currentIndex <= toIndex) this.currentIndex--;
                            else if (this.currentIndex < fromIndex && this.currentIndex >= toIndex) this.currentIndex++;
                        }
                        await this._syncPlaylistState();
                    });

                    el.addEventListener('click', (e) => {
                        if (e.target.closest('.list-remove')) {
                            e.stopPropagation();
                            this.playlist.splice(i, 1);
                            if(i < this.currentIndex) this.currentIndex--;
                            else if(i === this.currentIndex && this.playlist.length > 0) {
                                this.broadcastState(this.playlist[this.currentIndex].id, 0, true);
                                this.updateTrackTitle(this.playlist[this.currentIndex].title);
                            }
                            this._syncPlaylistState();
                        } else {
                            this.currentIndex = i;
                            this._syncPlaylistState();
                            this.broadcastState(v.id, 0, true);
                            this.updateTrackTitle(v.title);
                        }
                    });
                } else { el.classList.add('readonly'); }
                container.appendChild(el);
            });
            const activeEl = container.querySelector('.active-track');
            if(activeEl) activeEl.scrollIntoView({ block: "center", behavior: "smooth" });
        }
    }

    _onToggleInputMode(event, target) {
        this.isInputMode = !this.isInputMode;
        const s = this.element.querySelector('#view-seeker');
        const i = this.element.querySelector('#view-input');
        const b = target || this.element.querySelector('.toggle-mode-btn');
        if (!s || !i) return;
        if (this.isInputMode) {
            s.style.display = 'none'; i.style.display = 'flex';
            if(b) b.innerHTML = '<i class="fas fa-times"></i>';
            setTimeout(() => this.element.querySelector('input[name="smartInput"]')?.focus(), 50);
        } else {
            s.style.display = 'block'; i.style.display = 'none';
            if(b) b.innerHTML = '<i class="fas fa-plus"></i>';
            this._onCloseSearch();
        }
    }

    async _onExecuteSmartInput() {
        const input = this.element.querySelector('input[name="smartInput"]');
        if(!input) return;
        const val = input.value.trim();
        if(!val) return;
        await this._handleImport(val);
        input.value = "";
    }

    async _handleImport(val) {
        if (val.includes('list=')) {
            ui.notifications.info("Scanning Playlist...");
            const videos = await this._scrapeYoutubePlaylist(val);
            if (videos.length > 0) {
                this.addMultipleToPlaylist(videos);
                ui.notifications.info(`Imported ${videos.length} videos!`);
                this._onToggleInputMode(null, this.element.querySelector('.toggle-mode-btn'));
                return;
            } else {
                ui.notifications.warn("Could not import playlist. Privacy settings?");
            }
        }

        const videoId = this._extractVideoID(val);
        if (videoId) {
            ui.notifications.info("Loading info...");
            const meta = await this._fetchMetadata(videoId);
            this.addToPlaylist(meta);
            ui.notifications.info(`Added: ${meta.title}`);
            this._onToggleInputMode(null, this.element.querySelector('.toggle-mode-btn'));
        } else {
            this._showSearchOverlay();
            this._performSearch(val);
        }
    }

    _showSearchOverlay() { this.element.querySelector('#queue-overlay').classList.add('hidden'); this.element.querySelector('#search-overlay').classList.remove('hidden'); }
    _onCloseSearch() { this.element.querySelector('#search-overlay').classList.add('hidden'); }

    _onToggleQueue(event, target) {
        const overlay = this.element.querySelector('#queue-overlay');
        if (overlay) {
            overlay.classList.toggle('hidden');
            this.element.querySelector('#search-overlay').classList.add('hidden');
            target.classList.toggle('active');
        }
    }

    _onClearQueue() { Dialog.confirm({ title: "Clear Playlist", content: "<p>Clear playlist?</p>", yes: () => { this.playlist = []; this.currentIndex = -1; this._syncPlaylistState(); this.updateTrackTitle("No Video"); }, defaultYes: false }); }
    _onPlayNextAction() { this.playNext(); }
    _onPlayPrevAction() { this.playPrev(); }

    async _performSearch(q){const c=this.element.querySelector('#search-container');c.innerHTML='<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i></div>';const r=await this._searchYoutubeScrape(q);if(!r.length){c.innerHTML='<div class="empty-msg">No results.<br><a href="https://www.youtube.com/results?search_query='+encodeURIComponent(q)+'" target="_blank" style="text-decoration:underline">Open in Browser</a></div>';return;}c.innerHTML='';r.forEach(v=>{const el=document.createElement('div');el.className='list-item';el.innerHTML=`<img src="${v.thumb}" class="list-thumb"><div class="list-info"><div class="list-title" title="${v.title}">${v.title}</div><div class="list-meta">${v.author} • ${v.duration}</div></div><button class="list-btn list-add"><i class="fas fa-plus"></i></button><button class="list-btn list-play"><i class="fas fa-play"></i></button>`;el.querySelector('.list-add').addEventListener('click',(e)=>{e.stopPropagation();this.addToPlaylist(v);ui.notifications.info(`Added: ${v.title}`);});el.querySelector('.list-play').addEventListener('click',(e)=>{e.stopPropagation();this.playVideoNow(v);this._onCloseSearch();this._onToggleInputMode(null,this.element.querySelector('.toggle-mode-btn'));});c.appendChild(el);});}

    async _searchYoutubeScrape(q){const u=`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;try{const r=await fetch(PROXY_URL(u));if(!r.ok)return[];const t=await r.text();const m=t.match(/ytInitialData\s*=\s*({.+?});/);if(!m)return[];const d=JSON.parse(m[1]);const res=[];const c=d.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;if(c){for(const s of c){if(s.itemSectionRenderer){for(const i of s.itemSectionRenderer.contents){if(i.videoRenderer){const v=i.videoRenderer;res.push({id:v.videoId,title:v.title?.runs[0]?.text||"Video",author:v.ownerText?.runs[0]?.text||"YouTube",thumb:v.thumbnail?.thumbnails[0]?.url,duration:v.lengthText?.simpleText||"Live"});}}}}}return res.slice(0,20);}catch(e){return[];}}

    async _scrapeYoutubePlaylist(url) {
        try {
            const r = await fetch(PROXY_URL(url));
            if(!r.ok) return [];
            const t = await r.text();
            const m = t.match(/ytInitialData\s*=\s*({.+?});/);
            if(!m) return [];
            const data = JSON.parse(m[1]);

            let contents = data.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer?.contents;

            if(!contents) {
                contents = data.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.playlistVideoListRenderer?.contents;
            }

            if (!contents) return [];

            const videos = [];
            for (const item of contents) {
                if (item.playlistVideoRenderer) {
                    const v = item.playlistVideoRenderer;
                    videos.push({
                        id: v.videoId,
                        title: v.title?.runs[0]?.text || "Video",
                        author: v.shortBylineText?.runs[0]?.text || "YouTube",
                        thumb: v.thumbnail?.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
                        duration: v.lengthText?.simpleText || "0:00"
                    });
                }
            }
            return videos;
        } catch (e) {
            console.error("Tube Playlist Scrape Error:", e);
            return [];
        }
    }

    async _fetchMetadata(id){let m={id,title:`Video ${id}`,author:"YouTube",duration:"Video",thumb:`https://i.ytimg.com/vi/${id}/mqdefault.jpg`};try{const r=await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${id}`);if(r.ok){const d=await r.json();if(d.title)m.title=d.title;if(d.author_name)m.author=d.author_name;if(d.thumbnail_url)m.thumb=d.thumbnail_url;}}catch(e){}return m;}

    broadcastState(videoId, time=0, isPlaying=true) {
        this.loadVideo(videoId);
        setTimeout(() => { if(this.player?.playVideo && isPlaying) this.player.playVideo(); }, 800);
        this.emitSocket(null, { action: "syncState", videoId, time, isPlaying, isLooping: this.isLooping });
    }

    _onTogglePlayback() { if(this.player) this.player.getPlayerState()===1 ? (this.pauseVideo(), this.emitSocket("pause")) : (this.playVideo(this.player.getCurrentTime()), this.emitSocket("play", {time: this.player.getCurrentTime()})); }
    _onToggleLoop(event, target) { this.isLooping = !this.isLooping; if(target) target.classList.toggle('active'); this.emitSocket("syncLoop", {isLooping: this.isLooping}); }

    loadVideo(videoId) {
        this.localVideoId = videoId;
        if(this.player) { try{this.player.destroy();}catch(e){} this.player=null; }
        this._refreshTitle(videoId);
        setTimeout(() => this._tryInitPlayer(videoId), 100);
    }

    playVideo(time) { if(this.player?.seekTo) { this.player.seekTo(time, true); this.player.playVideo(); } }
    pauseVideo() { this.player?.pauseVideo(); }

    _tryInitPlayer(specificId = null) {
        if (!window.YT?.Player) { setTimeout(() => this._tryInitPlayer(specificId), 500); return; }
        const container = this.element.querySelector('#foundry-tube-player-target');
        if (!container) return;
        if (container.tagName === "IFRAME" && this.player && !specificId) return;
        const videoId = specificId || this.localVideoId || game.settings.get(MODULE_ID, 'currentVideoId') || '';
        this.localVideoId = videoId;
        const iframe = document.createElement('iframe');
        iframe.id = 'foundry-tube-iframe';
        iframe.style.width = "100%"; iframe.style.height = "100%"; iframe.style.position = "absolute";
        iframe.src = `https://www.youtube-nocookie.com/embed/${videoId}?enablejsapi=1&controls=0&rel=0&modestbranding=1&iv_load_policy=3&origin=${window.location.origin}`;
        container.innerHTML = ''; container.appendChild(iframe);
        this.player = new YT.Player(iframe, {
            events: {
                'onReady': (e) => {
                    e.target.setVolume(game.settings.get(MODULE_ID, 'clientVolume'));
                    this._startProgressLoop();
                    this._refreshTitle(videoId);
                    if (videoId && videoId.length > 0) e.target.playVideo();
                    if (!game.user.isGM) this.emitSocket("requestSync");
                },
                'onStateChange': (e) => this._onPlayerStateChange(e)
            }
        });
    }

    _onPlayerStateChange(event) {
        const btnIcon = this.element.querySelector('[data-action="togglePlayback"] i');
        if (btnIcon) btnIcon.className = event.data === YT.PlayerState.PLAYING ? "fas fa-pause" : "fas fa-play";
        if (event.data === YT.PlayerState.PLAYING) this._refreshTitle(this.localVideoId);
        if (game.user.isGM && event.data === YT.PlayerState.ENDED) { if (this.isLooping) { this.playVideo(0); this.emitSocket("play", { time: 0 }); } else { this.playNext(); } }
    }

    _startProgressLoop() { if (this.progressInterval) clearInterval(this.progressInterval); this.progressInterval = setInterval(() => { if (!this.player?.getCurrentTime) return; const cur = this.player.getCurrentTime(); const dur = this.player.getDuration(); const time = this.element.querySelector('#current-time'); const durl = this.element.querySelector('#duration-time'); const seek = this.element.querySelector('.video-seeker'); if(time) time.innerText = this._fmt(cur); if(durl) durl.innerText = this._fmt(dur); if(seek) { seek.max = dur; seek.value = cur; } }, 1000); }
    _fmt(s) { if(!s) return "0:00"; const m=Math.floor(s/60), sec=Math.floor(s%60); return `${m}:${sec<10?'0':''}${sec}`; }
    _extractVideoID(url) { if(!url) return null; const m = url.match(/(?:youtu\.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/); return m && m[1].length===11 ? m[1] : (url.length === 11 ? url : null); }
    emitSocket(a, d={}) { game.socket.emit(SOCKET_NAME, a ? {action:a, ...d} : d); }
}

let tubeApp;
Hooks.once('init', () => {
    game.settings.register(MODULE_ID, 'currentVideoId', { scope: 'world', config: false, type: String, default: "" });
    game.settings.register(MODULE_ID, 'clientVolume', { scope: 'client', config: false, type: Number, default: 50 });
    game.settings.register(MODULE_ID, 'playlist', { scope: 'world', config: false, type: Object, default: [] });
    game.settings.register(MODULE_ID, 'playlistIndex', { scope: 'world', config: false, type: Number, default: -1 });
    game.settings.register(MODULE_ID, 'savedPlaylists', { scope: 'world', config: false, type: Object, default: {} });

    if (!document.getElementById('yt-api-script')) {
        const tag = document.createElement('script'); tag.id = 'yt-api-script'; tag.src = "https://www.youtube.com/iframe_api";
        document.head.appendChild(tag);
    }
});
Hooks.once('ready', () => {
    tubeApp = new FoundryTubeApp();
    window.tubeApp = tubeApp;
    const m = game.modules.get(MODULE_ID);
    if (m) m.api = { open: () => tubeApp.render({ force: true }) };
    setTimeout(() => tubeApp.render(true), 500);
    game.socket.on(SOCKET_NAME, (p) => {
        if (p.userId === game.user.id || !tubeApp.rendered) return;
        if (p.action === "syncPlaylist") {
            tubeApp.playlist = p.playlist;
            tubeApp.currentIndex = p.index;
            tubeApp._renderPlaylist();
            if(tubeApp.currentIndex>=0 && tubeApp.playlist[tubeApp.currentIndex]) {
                tubeApp.updateTrackTitle(tubeApp.playlist[tubeApp.currentIndex].title);
            }
        }
        else if (p.action === "syncLoop") {
            tubeApp.isLooping = p.isLooping;
            const btn = tubeApp.element.querySelector('[data-action="toggleLoop"]');
            if(btn) p.isLooping ? btn.classList.add('active') : btn.classList.remove('active');
        }
        else if (p.action === "syncState") {
            if (p.videoId !== tubeApp.localVideoId) tubeApp.loadVideo(p.videoId);
            if (p.isPlaying) setTimeout(() => tubeApp.playVideo(p.time), 500);
            else setTimeout(() => { tubeApp.playVideo(p.time); tubeApp.pauseVideo(); }, 500);
        }
        else if (p.action === "play") tubeApp.playVideo(p.time);
        else if (p.action === "pause") tubeApp.pauseVideo();
        else if (p.action === "requestSync" && game.user.isGM) {
            const state = { action: "syncState", videoId: game.settings.get(MODULE_ID, 'currentVideoId'), time: tubeApp.player?.getCurrentTime() || 0, isPlaying: tubeApp.player?.getPlayerState()===1, isLooping: tubeApp.isLooping };
            game.socket.emit(SOCKET_NAME, state);
            game.socket.emit(SOCKET_NAME, { action: "syncPlaylist", playlist: tubeApp.playlist, index: tubeApp.currentIndex });
            game.socket.emit(SOCKET_NAME, { action: "syncLoop", isLooping: tubeApp.isLooping });
        }
    });
});
Hooks.on('getSceneControlButtons', (c) => {
    const t = c.find(cc => cc.name === "token");
    if(t) t.tools.push({ name: "foundry-tube", title: "Tube", icon: "fas fa-tv", onClick: () => {
        if (tubeApp.isCustomMinimized) tubeApp.minimize();
                       tubeApp.render({ force: true });
    }, button: true });
});
