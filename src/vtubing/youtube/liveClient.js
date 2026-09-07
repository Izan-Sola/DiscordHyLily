import axios from 'axios'
import { Logger } from '../../utils/Logger.js'
import { getVtubeConfig } from '../../vtube/vtubeConfig.js'

const API_BASE = 'https://www.googleapis.com/youtube/v3'

// Floor against a misbehaving/faked response burning quota - configurable
// via youtubeMinPollMs, but a poll interval below this is never honored.
const DEFAULT_MIN_POLL_MS = 10000

// ─── YouTube Live Chat Client ─────────────────────────────────────────
//
// Polls a video's live chat via the Data API and calls onMessage(author,
// text) for each new message. Needs YOUTUBE_API_KEY (just an API key,
// no OAuth - liveChatMessages.list is public read) and YOUTUBE_VIDEO_ID
// (the video ID of the live stream itself, e.g. from the watch URL).
export class YouTubeLiveChatClient {
    constructor({
        apiKey = process.env.YOUTUBE_API_KEY,
        videoId = process.env.YOUTUBE_VIDEO_ID,
        onMessage
    } = {}) {
        this.apiKey = apiKey
        this.videoId = videoId
        this.onMessage = onMessage
        this.liveChatId = null
        this.nextPageToken = undefined
        this.pollTimer = null
        this.stopped = false
        // Guards against re-emitting a message on retry/backoff, without
        // holding every id from a long stream in memory forever.
        this.seenIds = new Set()
    }

    async start() {
        if (!this.apiKey || !this.videoId) {
            throw new Error('YOUTUBE_API_KEY and YOUTUBE_VIDEO_ID must both be set')
        }

        this.liveChatId = await this._resolveLiveChatId()
        Logger.success(`Connected to live chat for video ${this.videoId}`, "YOUTUBE")
        this._poll()
    }

    async _resolveLiveChatId() {
        const res = await axios.get(`${API_BASE}/videos`, {
            params: { part: 'liveStreamingDetails', id: this.videoId, key: this.apiKey }
        })

        const liveChatId = res.data.items?.[0]?.liveStreamingDetails?.activeLiveChatId
        if (!liveChatId) {
            throw new Error(`No active live chat on video ${this.videoId} - is it actually live right now?`)
        }
        return liveChatId
    }

    _minPollMs() {
        const { youtubeMinPollMs } = getVtubeConfig()
        return youtubeMinPollMs ?? DEFAULT_MIN_POLL_MS
    }

    async _poll() {
        if (this.stopped) return

        try {
            const res = await axios.get(`${API_BASE}/liveChat/messages`, {
                params: {
                    liveChatId: this.liveChatId,
                    part: 'snippet,authorDetails',
                    pageToken: this.nextPageToken,
                    key: this.apiKey
                }
            })

            const { items = [], nextPageToken, pollingIntervalMillis } = res.data
            this.nextPageToken = nextPageToken

            for (const item of items) {
                if (this.seenIds.has(item.id)) continue
                this.seenIds.add(item.id)

                const author = item.authorDetails?.displayName ?? 'unknown'
                const text = item.snippet?.displayMessage
                if (text) this.onMessage(author, text)
            }

            if (this.seenIds.size > 2000) {
                this.seenIds = new Set([...this.seenIds].slice(-1000))
            }

            const delay = Math.max(pollingIntervalMillis ?? 10000, this._minPollMs())
            this.pollTimer = setTimeout(() => this._poll(), delay)
        } catch (err) {
            const reason = err.response?.data?.error?.errors?.[0]?.reason

            if (reason === 'liveChatEnded') {
                Logger.info('Live chat ended, stopping', "YOUTUBE")
                this.stop()
                return
            }

            const message = err.response?.data?.error?.message

            Logger.error(
                `Poll failed: HTTP ${err.response?.status} | reason=${reason} | message=${message}`,
                "YOUTUBE"
            )
            // Back off rather than dying outright - a single failed poll
            // (network blip, transient 5xx) shouldn't kill the whole feed.
            this.pollTimer = setTimeout(() => this._poll(), 10000)
        }
    }

    stop() {
        this.stopped = true
        if (this.pollTimer) clearTimeout(this.pollTimer)
    }
}