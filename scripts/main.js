const MODULE_ID = 'foundry-tube';
const SOCKET_NAME = `module.${MODULE_ID}`;
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const PROXIES = [
    (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
    (url) => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
    (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`
];

class FoundryTubeApp extends HandlebarsApplicationMixin(ApplicationV2) {
    constructor() {
        super();
        window.tubeApp = this;
        this.players = [null, null, null, null, null];
        this.activeTab = 0;
        this.tabsState = Array(5).fill(null).map(() => ({
            playlist: [], currentIndex: -1, localVideoId: "", isLooping: false, isInputMode: false, loaded: false
        }));
        this.isCustomMinimized = false;
        this.savedHeight = 360;
        this.savedWidth = 580;
        this.progressIntervals = [null, null, null, null, null];
        this._resizeObserver = null;
        this.initialLoad = true;
    }

    static DEFAULT_OPTIONS = {
        id: "foundry-tube-app", tag: "div",
        window: { title: "Tube", icon: "fas fa-tv", resizable: true, minimizable: true, controls: [] },
        position: { width: 580, height: 360, top: 100, left: 115 },
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
            importFromClipboard: FoundryTubeApp.prototype._onImportFromClipboard,
            switchTab: FoundryTubeApp.prototype._onSwitchTab
        }
    };

    static PARTS = { main: { template: `modules/${MODULE_ID}/templates/widget.hbs` } };

    async minimize() {
        this.isCustomMinimized = !this.isCustomMinimized;
        if (this.isCustomMinimized) {
            if (this.element) {
                this.savedWidth = this.element.offsetWidth;
                if (this.element.offsetHeight > 100) this.savedHeight = this.element.offsetHeight;
            }
            this.element.classList.add('custom-minimized');
            return this.setPosition({ height: 58, width: this.savedWidth });
        } else {
            this.element.classList.remove('custom-minimized');
            const w = this.savedWidth || 580;
            const h = (this.savedHeight && this.savedHeight > 100) ? this.savedHeight : 360;
            return this.setPosition({ width: w, height: h });
        }
    }

    async close(options={}) {
        if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }
        this.progressIntervals.forEach(i => clearInterval(i));
        if (!options.force) return;
        return super.close(options);
    }

    async _prepareContext(options) {
        const globalState = game.settings.get(MODULE_ID, 'tabsState') || {};
        const savedPlaylists = game.settings.get(MODULE_ID, 'savedPlaylists');
        const volume = game.settings.get(MODULE_ID, 'clientVolume');
        const tabsData = [];
        for(let i=0; i<5; i++) {
            if (!this.tabsState[i].loaded) {
                const s = globalState[i] || {};
                this.tabsState[i].playlist = s.playlist || [];
                this.tabsState[i].currentIndex = s.currentIndex ?? -1;
                this.tabsState[i].localVideoId = s.videoId || "";
                this.tabsState[i].isLooping = s.isLooping || false;
                this.tabsState[i].loaded = true;
            }
            tabsData.push({
                index: i, humanIndex: i + 1, isActive: (i === this.activeTab),
                          title: this.tabsState[i].playlist[this.tabsState[i].currentIndex]?.title || "No Video",
                          volume: volume, isLooping: this.tabsState[i].isLooping
            });
        }
        return { isGM: game.user.isGM, savedPlaylists, tabs: tabsData };
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

                        this.savedWidth = entry.contentRect.width;

                        this.position.width = entry.contentRect.width;
                    }
                });
                this._resizeObserver.observe(this.element);
            }

            for(let i=0; i<5; i++) {
                this._renderPlaylist(i);
                this._tryInitPlayer(i);
                if(this.tabsState[i].localVideoId) this._refreshTitle(i, this.tabsState[i].localVideoId);

                const container = this.element.querySelector(`.tube-instance[data-tab-index="${i}"]`);
                if(!container) continue;

                const smartInp = container.querySelector('input[name="smartInput"]');
                if(smartInp) {
                    const newInp = smartInp.cloneNode(true);
                    smartInp.parentNode.replaceChild(newInp, smartInp);
                    newInp.addEventListener('keydown', (e) => {
                        if(e.key === 'Enter') {
                            e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                            newInp.blur();
                            this.executeSmartInput(i);
                        }
                    });
                }

                const volInput = container.querySelector('input[name="volume"]');
                if (volInput) {
                    volInput.oninput = (e) => { if (this.players[i]?.setVolume) this.players[i].setVolume(parseInt(e.target.value)); };
                    volInput.onchange = async (e) => { await game.settings.set(MODULE_ID, 'clientVolume', parseInt(e.target.value)); };
                }

                const seeker = container.querySelector('.video-seeker');
                if (seeker && game.user.isGM) {
                    const newSeeker = seeker.cloneNode(true);
                    seeker.parentNode.replaceChild(newSeeker, seeker);
                    newSeeker.addEventListener('change', () => {
                        const val = parseFloat(newSeeker.value);
                        if (this.players[i]?.seekTo) {
                            this.players[i].seekTo(val, true);
                            this.emitSocket("play", { time: val, tabId: i });
                        }
                    });
                }

                const shield = container.querySelector(`#player-shield-${i}`);
                if (shield) shield.onclick = (e) => { e.stopPropagation(); this.togglePlayback(i); };
            }

            if (this.isCustomMinimized) {
                this.element.classList.add('custom-minimized');
                this.setPosition({ height: 58, width: this.savedWidth });
            }
        } catch (err) { console.error(err); }
    }

    async playVideoNow(tab, videoData) {
        const insertIdx = this.tabsState[tab].currentIndex + 1;
        this.tabsState[tab].playlist.splice(insertIdx, 0, videoData);
        this.tabsState[tab].currentIndex = insertIdx;
        await this._syncPlaylistState(tab);
        this.broadcastState(tab, videoData.id, 0, true);
        this.updateTrackTitle(tab, videoData.title);
    }

    async playNext(tab) {
        if (this.tabsState[tab].currentIndex + 1 >= this.tabsState[tab].playlist.length) return;
        this.tabsState[tab].currentIndex++;
        await this._syncPlaylistState(tab);
        const v = this.tabsState[tab].playlist[this.tabsState[tab].currentIndex];
        this.broadcastState(tab, v.id, 0, true);
        this.updateTrackTitle(tab, v.title);
    }

    async playPrev(tab) {
        if (this.tabsState[tab].currentIndex <= 0) return;
        this.tabsState[tab].currentIndex--;
        await this._syncPlaylistState(tab);
        const v = this.tabsState[tab].playlist[this.tabsState[tab].currentIndex];
        this.broadcastState(tab, v.id, 0, true);
        this.updateTrackTitle(tab, v.title);
    }

    broadcastState(tab, videoId, time=0, isPlaying=true) {
        this.loadVideo(tab, videoId);
        setTimeout(() => { if(this.players[tab]?.playVideo && isPlaying) this.players[tab].playVideo(); }, 800);
        this.emitSocket(null, { action: "syncState", tabId: tab, videoId, time, isPlaying, isLooping: this.tabsState[tab].isLooping });
    }

    loadVideo(tab, videoId) {
        this.tabsState[tab].localVideoId = videoId;
        this._refreshTitle(tab, videoId);
        if(this.players[tab] && typeof this.players[tab].loadVideoById === 'function') {
            this.players[tab].loadVideoById(videoId);
        } else {
            this._tryInitPlayer(tab);
        }
    }

    playVideo(tab, time) { if(this.players[tab]?.seekTo) { this.players[tab].seekTo(time, true); this.players[tab].playVideo(); } }
    pauseVideo(tab) { this.players[tab]?.pauseVideo(); }

    togglePlayback(tab) {
        const p = this.players[tab];
        if(p && typeof p.getPlayerState === 'function') {
            p.getPlayerState()===1 ? (this.pauseVideo(tab), this.emitSocket("pause", {tabId:tab})) : (this.playVideo(tab, p.getCurrentTime()), this.emitSocket("play", {time: p.getCurrentTime(), tabId:tab}));
        }
    }

    _onSwitchTab(event, target) {
        const idx = parseInt(target.dataset.target);
        this.activeTab = idx;
        this.element.querySelectorAll('.tube-instance').forEach(el => el.classList.remove('active'));
        this.element.querySelector(`.tube-instance[data-tab-index="${idx}"]`)?.classList.add('active');
        this.element.querySelectorAll('.channel-btn').forEach(btn => {
            const btnTarget = parseInt(btn.dataset.target);
            if (btnTarget === idx) btn.classList.add('active');
            else btn.classList.remove('active');
        });
    }

    _onTogglePlayback() { this.togglePlayback(this.activeTab); }
    _onToggleLoop(e, t) { this.toggleLoop(this.activeTab, t); }
    _onToggleInputMode(e, t) { this.toggleInputMode(this.activeTab); }
    _onExecuteSmartInput(e, t, forced) { this.executeSmartInput(forced ?? this.activeTab); }
    _onToggleQueue(e, t) {
        const o=this.element.querySelector(`#queue-overlay-${this.activeTab}`), s=this.element.querySelector(`#search-overlay-${this.activeTab}`);
        if(o){ o.classList.toggle('hidden'); if(s) s.classList.add('hidden'); t.classList.toggle('active'); }
    }
    _onClearQueue() { Dialog.confirm({ title: "Clear Playlist", content: "<p>Clear playlist?</p>", yes: () => { this.tabsState[this.activeTab].playlist=[]; this.tabsState[this.activeTab].currentIndex=-1; this._syncPlaylistState(this.activeTab); this.updateTrackTitle(this.activeTab, "No Video"); }}); }
    _onPlayNextAction() { this.playNext(this.activeTab); }
    _onPlayPrevAction() { this.playPrev(this.activeTab); }
    _onCloseSearch() { this.element.querySelector(`#search-overlay-${this.activeTab}`)?.classList.add('hidden'); }
    _onSavePreset() { const tab=this.activeTab; if(this.tabsState[tab].playlist.length===0) return ui.notifications.warn("Queue empty"); new Dialog({title:"Save", content:`<form><div class="form-group"><label>Name</label><input type="text" name="name" style="background:#fff;color:#000"/></div></form>`, buttons:{save:{label:"Save", callback:async(h)=>{const n=h.find('input').val().trim(); if(!n)return; const s=game.settings.get(MODULE_ID,'savedPlaylists'); s[n]=this.tabsState[tab].playlist; await game.settings.set(MODULE_ID,'savedPlaylists',s); this.render();}}}}).render(true); }
    async _onLoadPreset() { const tab=this.activeTab, s=this.element.querySelector(`.preset-select[data-tab="${tab}"]`), n=s.value, sv=game.settings.get(MODULE_ID,'savedPlaylists'); if(sv[n]) { this.tabsState[tab].playlist=[...sv[n]]; this.tabsState[tab].currentIndex=0; await this._syncPlaylistState(tab); if(this.tabsState[tab].playlist.length>0) { this.broadcastState(tab, this.tabsState[tab].playlist[0].id, 0, true); this.updateTrackTitle(tab, this.tabsState[tab].playlist[0].title); } } }
    async _onDeletePreset() { const tab=this.activeTab, s=this.element.querySelector(`.preset-select[data-tab="${tab}"]`), n=s.value; if(!n)return; const sv=game.settings.get(MODULE_ID,'savedPlaylists'); delete sv[n]; await game.settings.set(MODULE_ID,'savedPlaylists',sv); this.render(); }
    _onImportFromClipboard() { const tab=this.activeTab; new Dialog({title:"Import", content:`<form><div class="form-group"><label>URL</label><input type="text" name="url" style="background:#fff;color:#000"/></div></form>`, buttons:{import:{label:"Import", callback:async(h)=>{const u=h.find('input').val().trim(); await this._handleImport(tab, u);}}}}).render(true); }

    toggleLoop(tab, target) { this.tabsState[tab].isLooping = !this.tabsState[tab].isLooping; if(target) target.classList.toggle('active'); this.emitSocket("syncLoop", {isLooping: this.tabsState[tab].isLooping, tabId:tab}); }
    toggleInputMode(tab) { this.tabsState[tab].isInputMode = !this.tabsState[tab].isInputMode; const s=this.element.querySelector(`#view-seeker-${tab}`), i=this.element.querySelector(`#view-input-${tab}`); if(!s||!i)return; if(this.tabsState[tab].isInputMode){s.style.display='none';i.style.display='flex';setTimeout(()=>this.element.querySelector(`#view-input-${tab} input`)?.focus(),50);}else{s.style.display='block';i.style.display='none';this.element.querySelector(`#search-overlay-${tab}`)?.classList.add('hidden');} }
    async executeSmartInput(tab) { const i=this.element.querySelector(`#view-input-${tab} input`); if(!i)return; const v=i.value.trim(); if(!v)return; i.value=""; i.blur(); await this._handleImport(tab, v); }

    async _syncPlaylistState(tab) {
        if(game.user.isGM) {
            const globalState = game.settings.get(MODULE_ID, 'tabsState') || {};
            globalState[tab] = { playlist: this.tabsState[tab].playlist, currentIndex: this.tabsState[tab].currentIndex, videoId: (this.tabsState[tab].playlist[this.tabsState[tab].currentIndex]||{}).id||"", isLooping: this.tabsState[tab].isLooping };
            await game.settings.set(MODULE_ID, 'tabsState', globalState);
            this.emitSocket("syncPlaylist", { tabId: tab, playlist: this.tabsState[tab].playlist, index: this.tabsState[tab].currentIndex });
        }
        this._renderPlaylist(tab);
    }

    _renderPlaylist(tab) {
        const container = this.element.querySelector(`#playlist-container-${tab}`);
        const count = this.element.querySelector(`#playlist-count-${tab}`);
        if(count) count.innerText = this.tabsState[tab].playlist.length;
        if (container) {
            container.innerHTML = this.tabsState[tab].playlist.length ? '' : '<div class="empty-msg">Playlist is empty</div>';
            this.tabsState[tab].playlist.forEach((v, i) => {
                const el = document.createElement('div');
                el.className = 'list-item';
                el.dataset.index = i;
                if (i === this.tabsState[tab].currentIndex) el.classList.add('active-track');
                if (i < this.tabsState[tab].currentIndex) el.style.opacity = '0.5';
                const copyBtn = `<button class="list-copy" title="Copy Link"><i class="fas fa-link"></i></button>`;
                const removeBtn = game.user.isGM ? `<button class="list-remove" title="Remove"><i class="fas fa-times"></i></button>` : '';
                el.innerHTML = `<img src="${v.thumb}" class="list-thumb"><div class="list-info"><div class="list-title" title="${v.title}">${v.title}</div><div class="list-meta">${v.author} • ${v.duration}</div></div><div style="display:flex; align-items:center;">${copyBtn}${removeBtn}</div>`;
                el.querySelector('.list-copy').addEventListener('click', (e) => { e.stopPropagation(); game.clipboard.copyPlainText(`https://www.youtube.com/watch?v=${v.id}`); ui.notifications.info(`Link copied: ${v.title}`); });
                if (game.user.isGM) {
                    el.setAttribute('draggable', 'true');
                    el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', JSON.stringify({idx: i, tab: tab})); el.classList.add('dragging'); });
                    el.addEventListener('dragend', () => { el.classList.remove('dragging'); container.querySelectorAll('.drag-over').forEach(it => it.classList.remove('drag-over')); });
                    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag-over'); });
                    el.addEventListener('dragleave', () => { el.classList.remove('drag-over'); });
                    el.addEventListener('drop', async (e) => {
                        e.preventDefault(); el.classList.remove('drag-over');
                        const data = JSON.parse(e.dataTransfer.getData('text/plain'));
                        if(data.tab !== tab) return;
                        const fromIndex = data.idx;
                        const toIndex = i;
                        if (fromIndex === toIndex) return;
                        const currentId = (this.tabsState[tab].currentIndex >= 0) ? this.tabsState[tab].playlist[this.tabsState[tab].currentIndex].id : null;
                        const movedItem = this.tabsState[tab].playlist.splice(fromIndex, 1)[0];
                        this.tabsState[tab].playlist.splice(toIndex, 0, movedItem);
                        if (currentId) this.tabsState[tab].currentIndex = this.tabsState[tab].playlist.findIndex(x => x.id === currentId);
                        await this._syncPlaylistState(tab);
                    });
                    el.addEventListener('click', (e) => {
                        if (e.target.closest('.list-remove')) {
                            e.stopPropagation();
                            this.tabsState[tab].playlist.splice(i, 1);
                            if(i < this.tabsState[tab].currentIndex) this.tabsState[tab].currentIndex--;
                            else if(i === this.tabsState[tab].currentIndex && this.tabsState[tab].playlist.length > 0) {
                                const v = this.tabsState[tab].playlist[this.tabsState[tab].currentIndex];
                                this.broadcastState(tab, v.id, 0, true);
                                this.updateTrackTitle(tab, v.title);
                            }
                            this._syncPlaylistState(tab);
                        } else {
                            this.tabsState[tab].currentIndex = i;
                            this._syncPlaylistState(tab);
                            this.broadcastState(tab, v.id, 0, true);
                            this.updateTrackTitle(tab, v.title);
                        }
                    });
                } else { el.classList.add('readonly'); }
                container.appendChild(el);
            });
            const activeEl = container.querySelector('.active-track');
            if(activeEl) activeEl.scrollIntoView({ block: "center", behavior: "smooth" });
        }
    }

    _showProgressBar(tab) { const b=this.element.querySelector(`#queue-progress-${tab}`); const f=b?.querySelector('.queue-progress-bar'); if(b&&f){b.classList.add('active');f.style.width='10%';} }
    _updateProgressBar(tab, p) { const f=this.element.querySelector(`#queue-progress-${tab} .queue-progress-bar`); if(f) f.style.width=`${p}%`; }
    _hideProgressBar(tab) { const b=this.element.querySelector(`#queue-progress-${tab}`); if(b){ this._updateProgressBar(tab, 100); setTimeout(()=>{b.classList.remove('active');this._updateProgressBar(tab,0);},500); } }

    async _handleImport(tab, val) {
        if (val.includes('list=') || val.includes('playlist?')) {
            const overlay = this.element.querySelector(`#queue-overlay-${tab}`);
            if(overlay && overlay.classList.contains('hidden')) this.element.querySelector(`.tube-instance[data-tab-index="${tab}"] [data-action="toggleQueue"]`).click();
            this._showProgressBar(tab);
            ui.notifications.info(`Tab ${tab+1}: Scanning Playlist...`);
            const listId = this._extractPlaylistID(val);
            const cleanUrl = listId ? `https://www.youtube.com/playlist?list=${listId}` : val;
            const videos = await this._scrapeYoutubePlaylist(tab, cleanUrl);
            this._hideProgressBar(tab);
            if (videos.length > 0) {
                this.tabsState[tab].playlist.push(...videos);
                if (this.tabsState[tab].currentIndex === -1) {
                    this.tabsState[tab].currentIndex = 0;
                    this.broadcastState(tab, videos[0].id, 0, true);
                    this.updateTrackTitle(tab, videos[0].title);
                }
                this._syncPlaylistState(tab);
                ui.notifications.info(`Tab ${tab+1}: Imported ${videos.length} videos!`);
                this.toggleInputMode(tab);
                return;
            }
            const vidId = this._extractVideoID(val);
            if (vidId) return this._handleImport(tab, `https://www.youtube.com/watch?v=${vidId}`);
                ui.notifications.warn("Import failed.");
                return;
        }
        const videoId = this._extractVideoID(val);
        if (videoId) {
            this._showProgressBar(tab);
            ui.notifications.info("Loading info...");
            const meta = await this._fetchMetadata(videoId);
            this._hideProgressBar(tab);
            this.tabsState[tab].playlist.push(meta);
            if (this.tabsState[tab].currentIndex === -1) {
                this.tabsState[tab].currentIndex = 0;
                this.broadcastState(tab, meta.id, 0, true);
                this.updateTrackTitle(tab, meta.title);
            } else {
                ui.notifications.info(`Added: ${meta.title}`);
            }
            this._syncPlaylistState(tab);
            this.toggleInputMode(tab);
        } else {
            this.element.querySelector(`#queue-overlay-${tab}`)?.classList.add('hidden');
            this.element.querySelector(`#search-overlay-${tab}`)?.classList.remove('hidden');
            this._performSearch(tab, val);
        }
    }

    async _performSearch(tab, q){
        const c=this.element.querySelector(`#search-container-${tab}`);
        c.innerHTML='<div class="empty-msg"><i class="fas fa-spinner fa-spin"></i></div>';
        const results = await this._searchYoutubeScrape(q);
        if(!results.length){ c.innerHTML='<div class="empty-msg">No results.</div>'; return; }
        c.innerHTML='';
        results.forEach(v=>{
            const el=document.createElement('div');
            el.className='list-item';
            el.innerHTML=`<img src="${v.thumb}" class="list-thumb"><div class="list-info"><div class="list-title" title="${v.title}">${v.title}</div><div class="list-meta">${v.author} • ${v.duration||""}</div></div><button class="list-btn list-add"><i class="fas fa-plus"></i></button><button class="list-btn list-play"><i class="fas fa-play"></i></button>`;
            el.querySelector('.list-add').addEventListener('click',(e)=>{e.stopPropagation();this.tabsState[tab].playlist.push(v);if (this.tabsState[tab].currentIndex === -1) { this.tabsState[tab].currentIndex = 0; this.broadcastState(tab, v.id, 0, true); this.updateTrackTitle(tab, v.title); } this._syncPlaylistState(tab);ui.notifications.info(`Added: ${v.title}`);});
            el.querySelector('.list-play').addEventListener('click',(e)=>{e.stopPropagation();this.playVideoNow(tab, v);this.element.querySelector(`#search-overlay-${tab}`)?.classList.add('hidden');this.toggleInputMode(tab);});
            c.appendChild(el);
        });
    }

    async _fetchText(url) {
        for (const proxy of PROXIES) {
            try {
                const res = await fetch(proxy(url));
                if (res.ok) {
                    if (proxy.toString().includes("allorigins")) {
                        const json = await res.json();
                        if (json && json.contents) return json.contents;
                    } else {
                        const text = await res.text();
                        if(text.length > 100) return text;
                    }
                }
            } catch (e) {}
        }
        return null;
    }

    async _scrapeYoutubePlaylist(tab, url) {
        this._updateProgressBar(tab, 30);
        try {
            const t = await this._fetchText(url);
            if(!t) return [];
            this._updateProgressBar(tab, 60);
            const videos = [];
            try {
                const m = t.match(/ytInitialData\s*=\s*({.+?});/);
                if(m) {
                    const data = JSON.parse(m[1]);
                    const find = (obj) => {
                        if(!obj || typeof obj !== 'object') return;
                        if(obj.playlistVideoRenderer) { const v=obj.playlistVideoRenderer; videos.push({id:v.videoId,title:v.title?.runs?.[0]?.text||"Video",author:v.shortBylineText?.runs?.[0]?.text||"YouTube",thumb:v.thumbnail?.thumbnails?.[0]?.url,duration:v.lengthText?.simpleText||"0:00"}); return; }
                        if(obj.playlistPanelVideoRenderer) { const v=obj.playlistPanelVideoRenderer; videos.push({id:v.videoId,title:v.title?.simpleText||"Video",author:v.shortBylineText?.runs?.[0]?.text||"YouTube",thumb:v.thumbnail?.thumbnails?.[0]?.url,duration:v.lengthText?.simpleText||"0:00"}); return; }
                        Object.values(obj).forEach(val => find(val));
                    };
                    find(data);
                }
            } catch(e) {}
            if(videos.length === 0) {
                const regex = /watch\?v=([a-zA-Z0-9_-]{11})/g;
                let match; const seen=new Set();
                while ((match = regex.exec(t)) !== null) {
                    if(seen.has(match[1])) continue; seen.add(match[1]);
                    videos.push({ id: match[1], title: `Video ${match[1]}`, author: "YouTube", thumb: `https://i.ytimg.com/vi/${match[1]}/mqdefault.jpg`, duration: "--:--" });
                }
            }
            return videos;
        } catch (e) { return []; }
    }

    async _searchYoutubeScrape(q){
        try {
            const t = await this._fetchText(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`);
            if(!t) return [];
            try {
                const m=t.match(/ytInitialData\s*=\s*({.+?});/);
                if(m) {
                    const data = JSON.parse(m[1]);
                    const res = [];
                    const find = (obj) => {
                        if(!obj || typeof obj !== 'object') return;
                        if(obj.videoRenderer) {
                            const v = obj.videoRenderer;
                            res.push({ id: v.videoId, title: v.title?.runs?.[0]?.text||"Video", author: v.ownerText?.runs?.[0]?.text||"YouTube", thumb: v.thumbnail?.thumbnails?.[0]?.url, duration: v.lengthText?.simpleText||v.lengthText?.accessibility?.accessibilityData?.label||"Live" });
                            return;
                        }
                        Object.values(obj).forEach(val => find(val));
                    };
                    find(data);
                    if(res.length > 0) return res.slice(0, 20);
                }
            } catch(e) {}
            const regex = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
            const res = []; let match; const seen=new Set(); let limit=0;
            while ((match = regex.exec(t)) !== null && limit < 20) {
                if(seen.has(match[1])) continue; seen.add(match[1]);
                res.push({ id: match[1], title: "Loading...", author: "", thumb: `https://i.ytimg.com/vi/${match[1]}/mqdefault.jpg`, duration: "" });
                limit++;
            }
            return res;
        } catch(e){ return[]; }
    }

    async _fetchMetadata(id){let m={id,title:`Video ${id}`,author:"YouTube",duration:"",thumb:`https://i.ytimg.com/vi/${id}/mqdefault.jpg`};try{const r=await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${id}`);if(r.ok){const d=await r.json();if(d.title)m.title=d.title;if(d.author_name)m.author=d.author_name;if(d.thumbnail_url)m.thumb=d.thumbnail_url;}}catch(e){}return m;}
    _extractVideoID(url) { if(!url) return null; const m = url.match(/(?:youtu\.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/); return m && m[1].length===11 ? m[1] : (url.length === 11 ? url : null); }
    _extractPlaylistID(url) { const m = url.match(/[&?]list=([a-zA-Z0-9_-]+)/); return m ? m[1] : null; }

    updateTrackTitle(tabId, text) {
        const container = this.element.querySelector(`#view-seeker-${tabId} .track-info`);
        const el = this.element.querySelector(`#track-title-text-${tabId}`);
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

    async _refreshTitle(tabId, videoId) {
        if (!videoId) return;
        const inPlaylist = this.tabsState[tabId].playlist.find(v => v.id === videoId);
        if (inPlaylist && inPlaylist.title && inPlaylist.title !== "Video") {
            this.updateTrackTitle(tabId, inPlaylist.title);
            return;
        }
        if (this.players[tabId] && typeof this.players[tabId].getVideoData === 'function') {
            const data = this.players[tabId].getVideoData();
            if (data && data.title) { this.updateTrackTitle(tabId, data.title); return; }
        }
        const meta = await this._fetchMetadata(videoId);
        if (meta && meta.title) this.updateTrackTitle(tabId, meta.title);
    }

    _tryInitPlayer(tab) {
        if (!window.YT?.Player) { setTimeout(() => this._tryInitPlayer(tab), 500); return; }
        const container = this.element.querySelector(`#foundry-tube-player-${tab}`);
        if (!container) return;
        if (this.players[tab] && document.getElementById(`foundry-tube-iframe-${tab}`)) return;
        const videoId = this.tabsState[tab].localVideoId || "";
        container.innerHTML = "";
        const placeholder = document.createElement('div');
        placeholder.id = `foundry-tube-iframe-${tab}`;
        container.appendChild(placeholder);
        this.players[tab] = new YT.Player(`foundry-tube-iframe-${tab}`, {
            height: '100%', width: '100%', videoId: videoId,
            playerVars: { 'playsinline': 1, 'controls': 0, 'rel': 0, 'modestbranding': 1, 'iv_load_policy': 3, 'origin': window.location.origin },
            events: {
                'onReady': (e) => {
                    e.target.setVolume(game.settings.get(MODULE_ID, 'clientVolume'));
                    this._startProgressLoop(tab);
                    this._refreshTitle(tab, videoId);
                    const autoplay = game.settings.get(MODULE_ID, 'autoplayStart');
                    if (videoId && videoId.length > 0) {
                        if (!this.initialLoad || autoplay) e.target.playVideo();
                    }
                    if (!game.user.isGM) this.emitSocket("requestSync", {tabId: tab});
                    const f = e.target.getIframe();
                    f.style.width="150%"; f.style.height="150%"; f.style.position="absolute"; f.style.top="50%"; f.style.left="50%"; f.style.transform="translate(-50%,-50%)"; f.style.border="none"; f.style.pointerEvents="none";
                },
                'onStateChange': (e) => {
                    const isPlaying = e.data === YT.PlayerState.PLAYING;
                    const btn = this.element.querySelector(`.tube-instance[data-tab-index="${tab}"] [data-action="togglePlayback"] i`);
                    if (btn) btn.className = isPlaying ? "fas fa-pause" : "fas fa-play";
                    this.element.querySelectorAll(`.channel-btn[data-target="${tab}"]`).forEach(b => {
                        if (isPlaying) b.classList.add('playing'); else b.classList.remove('playing');
                    });
                        if (isPlaying) this._refreshTitle(tab, this.tabsState[tab].localVideoId);
                        if (game.user.isGM && e.data === YT.PlayerState.ENDED) {
                            if (this.tabsState[tab].isLooping) { this.playVideo(tab, 0); this.emitSocket("play", { time: 0, tabId: tab }); }
                            else { this.playNext(tab); }
                        }
                }
            }
        });
    }

    _startProgressLoop(tab) {
        if (this.progressIntervals[tab]) clearInterval(this.progressIntervals[tab]);
        this.progressIntervals[tab] = setInterval(() => {
            const p = this.players[tab];
            if (!p || !p.getCurrentTime) return;
            try {
                const cur = p.getCurrentTime();
                const dur = p.getDuration();
                const time = this.element.querySelector(`#current-time-${tab}`);
                const durl = this.element.querySelector(`#duration-time-${tab}`);
                const seek = this.element.querySelector(`.tube-instance[data-tab-index="${tab}"] .video-seeker`);
                if(time) time.innerText = this._fmt(cur);
                if(durl) durl.innerText = this._fmt(dur);
                if(seek) { seek.max = dur; if(document.activeElement !== seek) seek.value = cur; }
            } catch(e) {}
        }, 1000);
    }

    _fmt(s) { if (!s || isNaN(s)) return "0:00"; const sec=Math.floor(s%60), min=Math.floor((s/60)%60), hrs=Math.floor(s/3600); const ss=sec<10?`0${sec}`:sec; if(hrs>0) { const mm=min<10?`0${min}`:min; return `${hrs}:${mm}:${ss}`; } return `${min}:${ss}`; }
    emitSocket(a, d={}) { game.socket.emit(SOCKET_NAME, a ? {action:a, ...d} : d); }
}

let tubeApp;
Hooks.once('init', () => {
    game.settings.register(MODULE_ID, 'currentVideoId', { scope: 'world', config: false, type: String, default: "" });
    game.settings.register(MODULE_ID, 'tabsState', { scope: 'world', config: false, type: Object, default: {} });
    game.settings.register(MODULE_ID, 'clientVolume', { scope: 'client', config: false, type: Number, default: 50 });
    game.settings.register(MODULE_ID, 'savedPlaylists', { scope: 'world', config: false, type: Object, default: {} });
    game.settings.register(MODULE_ID, 'autoplayStart', { name: "Autoplay on World Join", hint: "If disabled, video will not start automatically when you log in.", scope: 'client', config: true, type: Boolean, default: true });

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
        const tab = p.tabId ?? 0;
        if (p.action === "syncPlaylist") {
            tubeApp.tabsState[tab].playlist = p.playlist;
            tubeApp.tabsState[tab].currentIndex = p.index;
            tubeApp._renderPlaylist(tab);
            if(tubeApp.tabsState[tab].currentIndex>=0 && tubeApp.tabsState[tab].playlist[tubeApp.tabsState[tab].currentIndex]) {
                tubeApp.updateTrackTitle(tab, tubeApp.tabsState[tab].playlist[tubeApp.tabsState[tab].currentIndex].title);
            }
        }
        else if (p.action === "syncLoop") {
            tubeApp.tabsState[tab].isLooping = p.isLooping;
            const btn = tubeApp.element.querySelector(`.tube-instance[data-tab-index="${tab}"] [data-action="toggleLoop"]`);
            if(btn) p.isLooping ? btn.classList.add('active') : btn.classList.remove('active');
        }
        else if (p.action === "syncState") {
            if (p.videoId !== tubeApp.tabsState[tab].localVideoId) tubeApp.loadVideo(tab, p.videoId);
            const autoplay = game.settings.get(MODULE_ID, 'autoplayStart');
            if (p.isPlaying) {
                if (tubeApp.initialLoad && !autoplay) { setTimeout(() => { tubeApp.playVideo(tab, p.time); tubeApp.pauseVideo(tab); }, 500); }
                else { setTimeout(() => tubeApp.playVideo(tab, p.time), 500); }
            } else {
                setTimeout(() => { tubeApp.playVideo(tab, p.time); tubeApp.pauseVideo(tab); }, 500);
            }
            if (tubeApp.initialLoad) tubeApp.initialLoad = false;
        }
        else if (p.action === "play") tubeApp.playVideo(tab, p.time);
        else if (p.action === "pause") tubeApp.pauseVideo(tab);
        else if (p.action === "requestSync" && game.user.isGM) {
            const global = game.settings.get(MODULE_ID, 'tabsState') || {};
            for(let i=0; i<5; i++) {
                const s = global[i] || {};
                const state = { action: "syncState", tabId: i, videoId: s.videoId||"", time: tubeApp.players[i]?.getCurrentTime() || 0, isPlaying: tubeApp.players[i]?.getPlayerState()===1, isLooping: tubeApp.tabsState[i].isLooping };
                game.socket.emit(SOCKET_NAME, state);
                game.socket.emit(SOCKET_NAME, { action: "syncPlaylist", tabId: i, playlist: tubeApp.tabsState[i].playlist, index: tubeApp.tabsState[i].currentIndex });
                game.socket.emit(SOCKET_NAME, { action: "syncLoop", tabId: i, isLooping: tubeApp.tabsState[i].isLooping });
            }
        }
    });
});
Hooks.on('getSceneControlButtons', (c) => {
    if (!c || !Array.isArray(c)) return;
    const t = c.find(cc => cc.name === "token");
    if(t) t.tools.push({ name: "foundry-tube", title: "Tube", icon: "fas fa-tv", onClick: () => {
        if (tubeApp.isCustomMinimized) tubeApp.minimize();
                       tubeApp.render({ force: true });
    }, button: true });
});
