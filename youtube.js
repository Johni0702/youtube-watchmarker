/* eslint-env webextensions, browser */

const VIDEO_ID_ATTR = 'yourect-videoid'
const WATCHED_MARKER_CLASS = 'yourect-watched-marker'
const WATCHED_BADGE_CLASS = 'yourect-watched-badge'

function isVideoThumbnail (elem) {
  let href = elem.getAttribute('href')
  if (!href) return false
  if (!href.startsWith('/watch?v=') &&
      !href.startsWith('https://www.youtube.com/watch?v=')) return false
  if (!elem.classList.contains('ytd-thumbnail' /* ordinary thumbnail */) &&
      !elem.classList.contains('ytp-ce-covering-overlay' /* end card */) &&
      !elem.classList.contains('ytp-videowall-still' /* after video  */)) return false
  return true
}

function getVideoId (elem) {
  let href = elem.getAttribute('href')
  let start = '/watch?v='
  return href.substring(href.indexOf(start) + start.length).substring(0, 11)
}

function getActiveVideoId () {
  if (window.location.pathname === '/watch') {
    const urlParams = new URLSearchParams(window.location.search)
    return urlParams.get('v')
  }
  return null
}

function getActiveVideoTitle () {
  return window.document.querySelector('ytd-video-primary-info-renderer .title').textContent
}

function createWatchedBadge (elem) {
  const badge = window.document.createElement('div')
  badge.classList.add('yourect-watched-badge')
  badge.textContent = 'WATCHED'
  elem.appendChild(badge)
}

function createActiveVideoWatchedBadge (videoId) {
  const elem = window.document.querySelector('ytd-video-primary-info-renderer')
  elem.style.position = 'relative'
  if (elem.getAttribute(VIDEO_ID_ATTR) !== videoId) {
    elem.setAttribute(VIDEO_ID_ATTR, videoId)
    elem.classList.remove(WATCHED_MARKER_CLASS)
  }

  if (elem.querySelector('#yourect-header-badge')) return

  const badge = window.document.createElement('div')
  badge.classList.add('yourect-watched-badge')
  badge.textContent = 'WATCHED'
  badge.id = 'yourect-header-badge'
  badge.style.left = 'auto'
  badge.style.right = '0px'
  elem.appendChild(badge)
}

class BgApi {
  constructor () {
    this.port = chrome.runtime.connect({
      name: 'new'
    })
  }

  addListener (func) {
    this.port.onMessage.addListener(func)
  }

  queryVideoIds (videoIds) {
    this.port.postMessage({
      type: 'query',
      videoIds: videoIds
    })
  }

  markAsWatched (videoId, videoTitle) {
    this.port.postMessage({
      type: 'watch',
      videoId: videoId,
      videoTitle: videoTitle,
      timestamp: new Date().getTime()
    })
  }
}

class Youtube {
  constructor () {
    this.bg = new BgApi()
    this.setupObserver = new MutationObserver(this.onSetupMutation.bind(this))
    this.videoTitleObserver = new MutationObserver(this.onVideoTitleMutation.bind(this))
    this.linkObserver = new MutationObserver(this.onLinkMutation.bind(this))
  }

  setup () {
    this.bg.addListener(this.onMessage.bind(this))
    this.setupObserver.observe(window.document.body, {
      childList: true,
      subtree: true
    })
    this.linkObserver.observe(window.document.body, {
      attributes: true,
      attributeFilter: ['class', 'href'],
      childList: true,
      subtree: true
    })
  }

  onSetupMutation (mutations, setupObserver) {
    for (const mutation of mutations) {
      let info = mutation.target.querySelector('ytd-video-primary-info-renderer')
      if (info) {
        this.setupThumbnails(window.document)
        this.setupActiveVideo()

        const title = info.querySelector('.title yt-formatted-string')
        this.videoTitleObserver.observe(title, {
          childList: true
        })

        // we can stop now, youtube won't ever unload this element
        setupObserver.disconnect()
      }
    }
  }

  onVideoTitleMutation (mutations, videoTitleObserver) {
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        this.setupActiveVideo()
        return
      }
    }
  }

  setupActiveVideo () {
    let videoId = getActiveVideoId()
    if (!videoId) return

    createActiveVideoWatchedBadge(videoId)
    this.bg.queryVideoIds([videoId])

    const video = window.document.querySelector('video')
    let listener = () => {
      if (video.closest('#movie_player').classList.contains('ad-showing')) {
        return // don't want to mark the video as watched when we're only watching an ad
      }

      // If we've seen at least 10 seconds (or half the video), mark it as watched
      if (video.currentTime > Math.min(10, video.duration / 2)) {
        if (getActiveVideoId() !== videoId) {
          return // switched to a different video by now
        }
        this.bg.markAsWatched(videoId, getActiveVideoTitle())
        video.removeEventListener('timeupdate', listener)
      }
    }
    video.addEventListener('timeupdate', listener)
  }

  setupThumbnails (container) {
    if (!container.querySelectorAll) return
    const elems = container.querySelectorAll('.ytd-thumbnail,.ytp-ce-covering-overlay,.ytp-videowall-still')
    let videoIds
    for (const elem of elems) {
      if (!isVideoThumbnail(elem)) continue

      if (!videoIds) {
        videoIds = []
      }
      videoIds.push(getVideoId(elem))

      this.setupThumbnail(elem)
    }
    if (videoIds) {
      this.bg.queryVideoIds(videoIds)
    }
  }

  setupThumbnail (elem) {
    const videoId = getVideoId(elem)
    if (!elem.querySelector('.' + WATCHED_BADGE_CLASS)) {
      createWatchedBadge(elem)
    }
    if (elem.getAttribute(VIDEO_ID_ATTR) === videoId) {
      return false
    } else {
      elem.setAttribute(VIDEO_ID_ATTR, videoId)
      elem.classList.remove(WATCHED_MARKER_CLASS)
      return true
    }
  }

  onLinkMutation (mutations, linkObserver) {
    let videoIds
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        const elem = mutation.target
        if (!isVideoThumbnail(elem)) continue
        if (!this.setupThumbnail(elem)) continue

        if (!videoIds) {
          videoIds = []
        }
        videoIds.push(getVideoId(elem))
      } else if (mutation.type === 'childList') {
        for (const elem of mutation.addedNodes) {
          this.setupThumbnails(elem)
        }
      }
    }
    if (videoIds) {
      this.bg.queryVideoIds(videoIds)
    }
  }

  applyWatchedState (videoId, watched) {
    const elems = window.document.querySelectorAll(`[${VIDEO_ID_ATTR}='${videoId}']`)
    for (const elem of elems) {
      if (watched) {
        elem.classList.add(WATCHED_MARKER_CLASS)
      } else {
        elem.classList.remove(WATCHED_MARKER_CLASS)
      }
    }
  }

  onMessage (msg) {
    switch (msg.type) {
      case 'hideProgressBar':
        let elem = window.document.createElement('style')
        elem.textContent = 'ytd-thumbnail-overlay-resume-playback-renderer { display:none; }'
        window.document.head.appendChild(elem)
        break
      case 'queryReply':
        for (const [videoId, watched] of Object.entries(msg.result)) {
          this.applyWatchedState(videoId, watched)
        }
        break
      case 'updateWatched':
        this.applyWatchedState(msg.videoId, msg.watched)
        break
    }
  }
}

const youtube = new Youtube()
youtube.setup()
