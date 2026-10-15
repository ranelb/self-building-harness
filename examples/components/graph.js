/**
 * CurveLab — one agent-authored SBH component: a pannable, zoomable, animated
 * curve editor with x/y boxes. No imports; a loaded module only receives `ctx`.
 *
 * State lives on the element (`root.__lab`) because `update` is called on every
 * host event — one per streamed chunk — and must not reset it.
 *
 * Theme colours come from `ctx.tokens` (`--sbh-*` names) and are read as canvas
 * colours, so a theme change restyles the plot too.
 */

const DEFAULTS = [
  { x: 0, y: 24 },
  { x: 1, y: 58 },
  { x: 2, y: 38 },
  { x: 3, y: 78 },
  { x: 4, y: 54 },
  { x: 5, y: 92 },
]

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const lerp = (a, b, t) => a + (b - a) * t
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

const niceNum = (range, round) => {
  const safe = range > 0 ? range : 1
  const exp = Math.floor(Math.log10(safe))
  const f = safe / Math.pow(10, exp)
  let nf
  if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10
  else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10
  return nf * Math.pow(10, exp)
}

const ticksFor = (min, max, count) => {
  const step = niceNum((max - min) / Math.max(1, count - 1), true)
  if (!(step > 0)) return [min]
  const out = []
  for (let v = Math.ceil(min / step) * step; v <= max + step * 0.5; v += step) {
    out.push(Math.abs(v) < step * 1e-6 ? 0 : v)
  }
  return out
}

const fmt = (v) => (Math.abs(v) >= 1000 || (v !== 0 && Math.abs(v) < 0.01) ? v.toPrecision(3) : String(Math.round(v * 100) / 100))

const withAlpha = (color, a) => {
  const hex = String(color).trim()
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex)
  if (!m) return color
  let h = m[1]
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${a})`
}

/** Catmull-Rom through the points, drawn as bezier segments. */
const traceCurve = (c, pts, sx, sy) => {
  c.beginPath()
  if (pts.length === 1) {
    c.arc(sx(pts[0].x), sy(pts[0].y), 3, 0, Math.PI * 2)
    return
  }
  c.moveTo(sx(pts[0].x), sy(pts[0].y))
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] || pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] || p2
    c.bezierCurveTo(
      sx(p1.x + (p2.x - p0.x) / 6),
      sy(p1.y + (p2.y - p0.y) / 6),
      sx(p2.x - (p3.x - p1.x) / 6),
      sy(p2.y - (p3.y - p1.y) / 6),
      sx(p2.x),
      sy(p2.y)
    )
  }
}

export const component = {
  name: 'graph',

  create(node, ctx) {
    const height = typeof node.props?.height === 'string' ? node.props.height : '320px'
    const root = document.createElement('div')
    root.setAttribute('data-atom', 'graph')
    root.style.cssText =
      'position:relative;display:flex;flex-direction:column;min-height:0;' +
      `flex:0 0 ${height};` +
      'border:1px solid var(--sbh-color-border);border-radius:var(--sbh-radius-lg);' +
      'background:linear-gradient(160deg,var(--sbh-color-surface),var(--sbh-color-surface-alt));' +
      'box-shadow:var(--sbh-shadow-md);overflow:hidden'

    const style = document.createElement('style')
    style.textContent =
      '@keyframes sbh-lab-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.72)}}' +
      '.sbh-lab-dot{animation:sbh-lab-pulse 2.4s ease-in-out infinite}' +
      '.sbh-lab-num:focus{background:var(--sbh-color-surface)!important}'
    root.appendChild(style)

    const header = document.createElement('div')
    header.style.cssText =
      'display:flex;align-items:center;gap:var(--sbh-space-sm);padding:var(--sbh-space-sm) var(--sbh-space-md);' +
      'border-bottom:1px solid var(--sbh-color-border)'
    const dot = document.createElement('span')
    dot.className = 'sbh-lab-dot'
    dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:var(--sbh-color-accent);box-shadow:0 0 10px var(--sbh-color-accent)'
    const title = document.createElement('div')
    title.textContent = 'CurveLab'
    title.style.cssText = 'font-weight:var(--sbh-font-weight-bold);letter-spacing:.02em'
    const hint = document.createElement('div')
    hint.textContent = 'drag to pan · scroll to zoom'
    hint.style.cssText = 'font-size:var(--sbh-font-size-sm);color:var(--sbh-color-text-muted)'
    const readout = document.createElement('div')
    readout.style.cssText = 'margin-left:auto;font-family:var(--sbh-font-mono);font-size:var(--sbh-font-size-sm);color:var(--sbh-color-text-muted)'
    header.append(dot, title, hint, readout)

    const canvasWrap = document.createElement('div')
    canvasWrap.style.cssText = 'position:relative;flex:1 1 auto;min-height:0'
    const canvas = document.createElement('canvas')
    canvas.style.cssText = 'display:block;width:100%;height:100%;cursor:grab;touch-action:none'
    canvasWrap.appendChild(canvas)

    const editor = document.createElement('div')
    editor.style.cssText =
      'display:flex;flex-wrap:wrap;gap:var(--sbh-space-xs);padding:var(--sbh-space-sm) var(--sbh-space-md);' +
      'border-top:1px solid var(--sbh-color-border);align-items:center'

    root.append(header, canvasWrap, editor)

    const state = {
      ctx,
      points: (Array.isArray(node.props?.points) ? node.props.points : DEFAULTS).map((p) => ({ x: p.x, y: p.y })),
      view: null,
      anim: null,
      hover: null,
      drag: null,
      w: 0,
      h: 0,
      dpr: 1,
      raf: 0,
      dead: false,
      lastReadout: '',
    }
    root.__lab = state

    const geometry = () => {
      const v = state.view
      const pad = { l: 44, r: 16, t: 16, b: 28 }
      const plotW = Math.max(1, state.w - pad.l - pad.r)
      const plotH = Math.max(1, state.h - pad.t - pad.b)
      return {
        pad,
        plotW,
        plotH,
        sx: (x) => pad.l + ((x - v.xMin) / (v.xMax - v.xMin)) * plotW,
        sy: (y) => pad.t + ((v.yMax - y) / (v.yMax - v.yMin)) * plotH,
        invX: (px) => v.xMin + ((px - pad.l) / plotW) * (v.xMax - v.xMin),
        invY: (py) => v.yMax - ((py - pad.t) / plotH) * (v.yMax - v.yMin),
      }
    }

    const fitView = () => {
      const xs = state.points.map((p) => p.x)
      const ys = state.points.map((p) => p.y)
      const xMin = xs.length ? Math.min(...xs) : 0
      const xMax = xs.length ? Math.max(...xs) : 1
      const yMin = ys.length ? Math.min(...ys) : 0
      const yMax = ys.length ? Math.max(...ys) : 1
      const padX = (xMax - xMin || 1) * 0.14
      const padY = (yMax - yMin || 1) * 0.2
      state.view = { xMin: xMin - padX, xMax: xMax + padX, yMin: yMin - padY, yMax: yMax + padY }
    }
    fitView()

    /** Mutate the points and animate from the current ones to the result. */
    const edit = (mutate) => {
      const from = state.points.map((p) => ({ x: p.x, y: p.y }))
      mutate(state.points)
      const to = state.points.map((p) => ({ x: p.x, y: p.y }))
      state.anim = { from, to, start: performance.now(), dur: 420 }
    }

    const resize = () => {
      const rect = canvasWrap.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      state.dpr = dpr
      state.w = rect.width
      state.h = rect.height
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(rect.height * dpr))
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvasWrap)
    resize()

    const colors = () => {
      const t = state.ctx.tokens
      return {
        accent: t['--sbh-color-accent'] || '#4b7bec',
        accentText: t['--sbh-color-accent-text'] || '#fff',
        text: t['--sbh-color-text'] || '#e6e6e6',
        muted: t['--sbh-color-text-muted'] || '#9a9aa5',
        border: t['--sbh-color-border'] || '#33333d',
        panel: t['--sbh-color-surface-alt'] || '#25252c',
        mono: t['--sbh-font-mono'] || 'monospace',
      }
    }

    const draw = (now) => {
      const c = canvas.getContext('2d')
      const col = colors()
      const g = geometry()
      c.setTransform(state.dpr, 0, 0, state.dpr, 0, 0)
      c.clearRect(0, 0, state.w, state.h)

      // grid + ticks
      c.strokeStyle = col.border
      c.fillStyle = col.muted
      c.font = `11px ${col.mono}`
      c.lineWidth = 1
      for (const tx of ticksFor(state.view.xMin, state.view.xMax, 6)) {
        const px = g.sx(tx)
        if (px < g.pad.l - 1 || px > state.w - g.pad.r + 1) continue
        c.globalAlpha = 0.45
        c.beginPath()
        c.moveTo(px, g.pad.t)
        c.lineTo(px, state.h - g.pad.b)
        c.stroke()
        c.globalAlpha = 1
        c.textAlign = 'center'
        c.fillText(fmt(tx), px, state.h - g.pad.b + 16)
      }
      for (const ty of ticksFor(state.view.yMin, state.view.yMax, 5)) {
        const py = g.sy(ty)
        if (py < g.pad.t - 1 || py > state.h - g.pad.b + 1) continue
        c.globalAlpha = 0.45
        c.beginPath()
        c.moveTo(g.pad.l, py)
        c.lineTo(state.w - g.pad.r, py)
        c.stroke()
        c.globalAlpha = 1
        c.textAlign = 'right'
        c.fillText(fmt(ty), g.pad.l - 8, py + 4)
      }

      // animated points
      let pts = state.points.map((p) => ({ x: p.x, y: p.y }))
      if (state.anim) {
        const t = ease(clamp((now - state.anim.start) / state.anim.dur, 0, 1))
        const anim = state.anim
        pts = anim.to.map((p, i) => {
          const f = anim.from[i] || { x: p.x, y: state.view.yMin }
          return { x: lerp(f.x, p.x, t), y: lerp(f.y, p.y, t) }
        })
        if (t >= 1) state.anim = null
      }
      pts.sort((a, b) => a.x - b.x)

      if (pts.length) {
        // area under the curve
        traceCurve(c, pts, g.sx, g.sy)
        const first = pts[0]
        const last = pts[pts.length - 1]
        const base = state.h - g.pad.b
        c.lineTo(g.sx(last.x), base)
        c.lineTo(g.sx(first.x), base)
        c.closePath()
        const gradient = c.createLinearGradient(0, g.pad.t, 0, base)
        gradient.addColorStop(0, withAlpha(col.accent, 0.38))
        gradient.addColorStop(1, withAlpha(col.accent, 0))
        c.fillStyle = gradient
        c.fill()

        // the curve, with a soft glow
        traceCurve(c, pts, g.sx, g.sy)
        c.strokeStyle = col.accent
        c.lineWidth = 2.5
        c.lineJoin = 'round'
        c.shadowColor = withAlpha(col.accent, 0.8)
        c.shadowBlur = 14
        c.stroke()
        c.shadowBlur = 0

        // point handles, gently breathing
        pts.forEach((p, i) => {
          const px = g.sx(p.x)
          const py = g.sy(p.y)
          const pulse = 1 + 0.18 * Math.sin(now / 620 + i * 1.3)
          c.beginPath()
          c.arc(px, py, 6 * pulse, 0, Math.PI * 2)
          c.fillStyle = withAlpha(col.accent, 0.18)
          c.fill()
          c.beginPath()
          c.arc(px, py, 3.4, 0, Math.PI * 2)
          c.fillStyle = col.accent
          c.fill()
          c.lineWidth = 1.5
          c.strokeStyle = col.panel
          c.stroke()
        })
      }

      // crosshair + tooltip
      if (state.hover) {
        const { px, py } = state.hover
        c.save()
        c.setLineDash([4, 4])
        c.strokeStyle = withAlpha(col.muted, 0.6)
        c.lineWidth = 1
        c.beginPath()
        c.moveTo(px, g.pad.t)
        c.lineTo(px, state.h - g.pad.b)
        c.moveTo(g.pad.l, py)
        c.lineTo(state.w - g.pad.r, py)
        c.stroke()
        c.restore()
        const label = `${fmt(g.invX(px))}, ${fmt(g.invY(py))}`
        c.font = `11px ${col.mono}`
        const w = c.measureText(label).width + 14
        const bx = clamp(px + 10, g.pad.l, state.w - g.pad.r - w)
        const by = clamp(py - 26, g.pad.t, state.h - g.pad.b - 20)
        c.fillStyle = withAlpha(col.text, 0.12)
        c.strokeStyle = col.border
        c.beginPath()
        c.roundRect(bx, by, w, 19, 6)
        c.fill()
        c.stroke()
        c.fillStyle = col.text
        c.textAlign = 'left'
        c.fillText(label, bx + 7, by + 13.5)
      }

      const text = `${fmt(state.view.xMin)} … ${fmt(state.view.xMax)}   |   ${fmt(state.view.yMin)} … ${fmt(state.view.yMax)}`
      if (text !== state.lastReadout) {
        readout.textContent = text
        state.lastReadout = text
      }
    }

    const loop = (now) => {
      if (state.dead) return
      draw(now)
      state.raf = requestAnimationFrame(loop)
    }
    state.raf = requestAnimationFrame(loop)

    // --- pointer: pan, zoom, crosshair -------------------------------------
    const localPos = (e) => {
      const rect = canvas.getBoundingClientRect()
      return { px: e.clientX - rect.left, py: e.clientY - rect.top }
    }
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId)
      state.drag = { x: e.clientX, y: e.clientY, view: { ...state.view } }
      canvas.style.cursor = 'grabbing'
    })
    canvas.addEventListener('pointermove', (e) => {
      const { px, py } = localPos(e)
      if (state.drag) {
        const g = geometry()
        const dx = ((e.clientX - state.drag.x) / g.plotW) * (state.drag.view.xMax - state.drag.view.xMin)
        const dy = ((e.clientY - state.drag.y) / g.plotH) * (state.drag.view.yMax - state.drag.view.yMin)
        state.view = {
          xMin: state.drag.view.xMin - dx,
          xMax: state.drag.view.xMax - dx,
          yMin: state.drag.view.yMin + dy,
          yMax: state.drag.view.yMax + dy,
        }
      }
      state.hover = { px, py }
    })
    const endDrag = () => {
      state.drag = null
      canvas.style.cursor = 'grab'
    }
    canvas.addEventListener('pointerup', endDrag)
    canvas.addEventListener('pointercancel', endDrag)
    canvas.addEventListener('pointerleave', () => {
      state.hover = null
      endDrag()
    })
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        const { px, py } = localPos(e)
        const g = geometry()
        const fx = g.invX(px)
        const fy = g.invY(py)
        const factor = e.deltaY < 0 ? 0.88 : 1.14
        const v = state.view
        state.view = {
          xMin: fx + (v.xMin - fx) * factor,
          xMax: fx + (v.xMax - fx) * factor,
          yMin: fy + (v.yMin - fy) * factor,
          yMax: fy + (v.yMax - fy) * factor,
        }
      },
      { passive: false }
    )

    // --- the x/y boxes ------------------------------------------------------
    const numberBox = (axis, value, onInput) => {
      const wrap = document.createElement('label')
      wrap.style.cssText = 'display:flex;align-items:center;gap:2px;font-family:var(--sbh-font-mono);font-size:11px'
      const tag = document.createElement('span')
      tag.textContent = axis
      tag.style.color = 'var(--sbh-color-text-muted)'
      const input = document.createElement('input')
      input.className = 'sbh-lab-num'
      input.type = 'number'
      input.value = String(value)
      input.style.cssText =
        'width:46px;background:transparent;border:none;border-radius:var(--sbh-radius-sm);' +
        'color:var(--sbh-color-text);font:inherit;outline:none;text-align:right;padding:0 2px'
      input.addEventListener('input', () => {
        const v = Number(input.value)
        if (Number.isFinite(v)) onInput(v)
      })
      wrap.append(tag, input)
      return wrap
    }

    const chipButton = (label, onClick, accent) => {
      const button = document.createElement('button')
      button.textContent = label
      button.style.cssText =
        'border:1px solid var(--sbh-color-border);border-radius:var(--sbh-radius-full);' +
        'padding:2px 10px;font-family:var(--sbh-font-sans);font-size:var(--sbh-font-size-sm);cursor:pointer;' +
        (accent
          ? 'background:var(--sbh-color-accent);color:var(--sbh-color-accent-text);border-color:transparent'
          : 'background:var(--sbh-color-surface);color:var(--sbh-color-text)')
      button.addEventListener('click', onClick)
      return button
    }

    const buildEditor = () => {
      editor.replaceChildren()
      state.points.forEach((point, index) => {
        const row = document.createElement('div')
        row.style.cssText =
          'display:flex;align-items:center;gap:4px;background:var(--sbh-color-surface);' +
          'border:1px solid var(--sbh-color-border);border-radius:var(--sbh-radius-full);padding:2px 6px'
        const swatch = document.createElement('span')
        swatch.textContent = String(index + 1)
        swatch.style.cssText =
          'width:16px;height:16px;border-radius:50%;display:grid;place-items:center;font-size:9px;' +
          'background:var(--sbh-color-accent);color:var(--sbh-color-accent-text)'
        const remove = document.createElement('button')
        remove.textContent = '×'
        remove.style.cssText =
          'border:none;background:transparent;color:var(--sbh-color-text-muted);cursor:pointer;font-size:13px;line-height:1'
        remove.addEventListener('click', () => {
          edit((pts) => pts.splice(index, 1))
          buildEditor()
        })
        row.append(
          swatch,
          numberBox('x', point.x, (v) => edit((pts) => { pts[index].x = v })),
          numberBox('y', point.y, (v) => edit((pts) => { pts[index].y = v })),
          remove
        )
        editor.appendChild(row)
      })
      editor.appendChild(
        chipButton('+ point', () => {
          const last = state.points[state.points.length - 1] || { x: 0, y: 0 }
          edit((pts) => pts.push({ x: last.x + 1, y: Math.round(last.y * 0.6 + 30) }))
          buildEditor()
        }, true)
      )
      editor.appendChild(chipButton('fit', fitView))
      editor.appendChild(
        chipButton('jitter', () => {
          edit((pts) => pts.forEach((p) => { p.y = clamp(p.y + (Math.random() - 0.5) * 30, 0, 120) }))
        })
      )
    }
    buildEditor()

    ctx.bind(root, node)
    return root
  },

  update(el, node, ctx) {
    const state = el.__lab
    if (state) state.ctx = ctx
    ctx.bind(el, node)
  },

  destroy(el) {
    const state = el.__lab
    if (!state) return
    state.dead = true
    cancelAnimationFrame(state.raf)
  },
}
