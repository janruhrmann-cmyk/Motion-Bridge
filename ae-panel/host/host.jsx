/**
 * Motion Bridge - After Effects host script.
 *
 * ExtendScript is ES3: no JSON object, no let/const, no arrow functions,
 * no Array.map/forEach, no trailing commas. Keep it that way.
 *
 * Towards Figma, this script only reads the composition and reports what is
 * there. All interpretation (easing conversion, shape building, warnings)
 * happens in the panel, in shared/ae-convert.ts, where it can be type-checked
 * and tested. From Figma it is the same the other way round: the panel works
 * out a build plan (shared/ae-build.ts) and the last part of this script
 * carries it out (see "building from a plan").
 */
var MOTIONBRIDGE = (function () {
  var VERSION = '1.0.0';
  var MAX_SAMPLES = 1800;

  // ------------------------------------------------------------------ JSON

  function quote(s) {
    var out = ['"'], i, c, code, hex;
    s = String(s);
    for (i = 0; i < s.length; i++) {
      c = s.charAt(i);
      code = s.charCodeAt(i);
      if (c === '"') out.push('\\"');
      else if (c === '\\') out.push('\\\\');
      else if (code === 10) out.push('\\n');
      else if (code === 13) out.push('\\r');
      else if (code === 9) out.push('\\t');
      else if (code < 32 || code > 126) {
        hex = code.toString(16);
        while (hex.length < 4) hex = '0' + hex;
        out.push('\\u' + hex);
      } else out.push(c);
    }
    out.push('"');
    return out.join('');
  }

  function stringify(v) {
    var t = typeof v, parts, i, k;
    if (v === null || v === undefined) return 'null';
    if (t === 'number') return isFinite(v) ? String(v) : 'null';
    if (t === 'boolean') return v ? 'true' : 'false';
    if (t === 'string') return quote(v);
    if (v instanceof Array) {
      parts = [];
      for (i = 0; i < v.length; i++) parts.push(stringify(v[i]));
      return '[' + parts.join(',') + ']';
    }
    if (t === 'object') {
      parts = [];
      for (k in v) {
        if (v.hasOwnProperty(k) && v[k] !== undefined && typeof v[k] !== 'function') {
          parts.push(quote(k) + ':' + stringify(v[k]));
        }
      }
      return '{' + parts.join(',') + '}';
    }
    return 'null';
  }

  // --------------------------------------------------------------- helpers

  function num(n) {
    return (typeof n === 'number' && isFinite(n)) ? Math.round(n * 100000) / 100000 : 0;
  }

  /** Numbers and number arrays, rounded. Anything else becomes null. */
  function clean(v) {
    var out, i;
    if (typeof v === 'number') return num(v);
    if (v instanceof Array) {
      out = [];
      for (i = 0; i < v.length; i++) out.push(num(v[i]));
      return out;
    }
    return null;
  }

  function tryGet(obj, name) {
    try { return obj[name]; } catch (e) { return undefined; }
  }

  function differs(a, b) {
    var i;
    if (typeof a === 'number' || typeof b === 'number') return Math.abs(a - b) > 0.0001;
    if (!a || !b || a.length !== b.length) return true;
    for (i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 0.0001) return true;
    return false;
  }

  function interpName(t) {
    if (t === KeyframeInterpolationType.HOLD) return 'h';
    if (t === KeyframeInterpolationType.LINEAR) return 'l';
    return 'b';
  }

  function easeList(list) {
    var out = [], i;
    for (i = 0; i < list.length; i++) out.push({ s: num(list[i].speed), i: num(list[i].influence) });
    return out;
  }

  function blendName(mode) {
    var B = BlendingMode;
    if (mode === B.NORMAL) return 'normal';
    if (mode === B.DARKEN) return 'darken';
    if (mode === B.MULTIPLY) return 'multiply';
    if (mode === B.COLOR_BURN || mode === B.CLASSIC_COLOR_BURN) return 'color-burn';
    if (mode === B.LINEAR_BURN) return 'linear-burn';
    if (mode === B.ADD || mode === B.LINEAR_DODGE) return 'linear-dodge';
    if (mode === B.LIGHTEN) return 'lighten';
    if (mode === B.SCREEN) return 'screen';
    if (mode === B.COLOR_DODGE || mode === B.CLASSIC_COLOR_DODGE) return 'color-dodge';
    if (mode === B.OVERLAY) return 'overlay';
    if (mode === B.SOFT_LIGHT) return 'soft-light';
    if (mode === B.HARD_LIGHT) return 'hard-light';
    if (mode === B.DIFFERENCE || mode === B.CLASSIC_DIFFERENCE) return 'difference';
    if (mode === B.EXCLUSION) return 'exclusion';
    if (mode === B.HUE) return 'hue';
    if (mode === B.SATURATION) return 'saturation';
    if (mode === B.COLOR) return 'color';
    if (mode === B.LUMINOSITY) return 'luminosity';
    return 'other';
  }

  function justifyName(j) {
    var P = ParagraphJustification;
    if (j === P.LEFT_JUSTIFY) return 'left';
    if (j === P.RIGHT_JUSTIFY) return 'right';
    if (j === P.CENTER_JUSTIFY) return 'center';
    return 'justify';
  }

  // ------------------------------------------------------------ properties

  /** True when the motion path between two position keys is not a straight line. */
  function curved(a, b) {
    var dx = b.v[0] - a.v[0], dy = b.v[1] - a.v[1];
    var len = Math.sqrt(dx * dx + dy * dy);
    var ot = a.ot || [0, 0], it = b.it || [0, 0];
    var otLen = Math.sqrt(ot[0] * ot[0] + ot[1] * ot[1]);
    var itLen = Math.sqrt(it[0] * it[0] + it[1] * it[1]);
    if (otLen < 0.01 && itLen < 0.01) return false;
    if (len < 0.0001) return true;
    if (Math.abs(ot[0] * dy - ot[1] * dx) / len > 0.05) return true;
    if (Math.abs(it[0] * dy - it[1] * dx) / len > 0.05) return true;
    return false;
  }

  /**
   * Some motion cannot be described by one easing curve per key pair:
   * curved motion paths, roving keys, a value that leaves and returns to the
   * same number, colour keys with a speed. Those get sampled per frame.
   */
  function needsSampling(keys, spatial, isColor) {
    var i, d, a, b, dims, va, vb, oe, ie;
    for (i = 0; i < keys.length - 1; i++) {
      a = keys[i];
      b = keys[i + 1];
      if (a.rv || b.rv) return true;
      if (a.oi === 'h') continue;
      if (spatial) {
        if (curved(a, b)) return true;
        continue;
      }
      if (a.oi === 'l' && b.ii === 'l') continue;
      if (isColor) {
        if (Math.abs(a.oe[0].s) > 0.0001 || Math.abs(b.ie[0].s) > 0.0001) return true;
        continue;
      }
      dims = (a.v instanceof Array) ? a.v.length : 1;
      for (d = 0; d < dims; d++) {
        va = (a.v instanceof Array) ? a.v[d] : a.v;
        vb = (b.v instanceof Array) ? b.v[d] : b.v;
        oe = a.oe[d] || a.oe[0];
        ie = b.ie[d] || b.ie[0];
        if (Math.abs(vb - va) < 0.000001 && (Math.abs(oe.s) > 0.0001 || Math.abs(ie.s) > 0.0001)) return true;
      }
    }
    return false;
  }

  function expressionMoves(prop, env) {
    var n = 12, i, first, v;
    first = clean(prop.valueAtTime(0, false));
    for (i = 1; i <= n; i++) {
      v = clean(prop.valueAtTime(env.comp.duration * i / n, false));
      if (differs(first, v)) return true;
    }
    return false;
  }

  function sampleProp(prop, env) {
    var fd = env.comp.frameDuration;
    var n = Math.round(env.comp.duration / fd);
    var step = 1, vals = [], f;
    while (n / step > MAX_SAMPLES) step++;
    for (f = 0; f <= n; f += step) vals.push(clean(prop.valueAtTime(f * fd, false)));
    return { dt: fd * step, v: vals };
  }

  /**
   * Reads one property:
   *   v   value at the poster time
   *   k   keys: t, v, ii/oi (in/out interpolation: l, b, h), ie/oe (ease
   *       speed + influence per dimension), it/ot (spatial tangents), rv (roving)
   *   s   per-frame samples when the keys alone cannot describe the motion
   *   sp  spatial property, ex expression active
   */
  function dumpProp(prop, env) {
    var out = {}, nk = 0, hasExpr = false, pvt, spatial, isColor, i, key, sample = false;
    if (!prop) return null;
    pvt = prop.propertyValueType;
    spatial = (pvt === PropertyValueType.TwoD_SPATIAL || pvt === PropertyValueType.ThreeD_SPATIAL);
    isColor = (pvt === PropertyValueType.COLOR);
    try { nk = prop.numKeys; } catch (e1) { nk = 0; }
    try {
      hasExpr = prop.canSetExpression && prop.expressionEnabled && prop.expression !== '';
    } catch (e2) { hasExpr = false; }

    out.v = clean((nk > 0 || hasExpr) ? prop.valueAtTime(env.poster, false) : prop.value);
    if (spatial) out.sp = 1;

    if (nk > 0) {
      out.k = [];
      for (i = 1; i <= nk; i++) {
        key = {
          t: num(prop.keyTime(i)),
          v: clean(prop.keyValue(i)),
          ii: interpName(prop.keyInInterpolationType(i)),
          oi: interpName(prop.keyOutInterpolationType(i)),
          ie: easeList(prop.keyInTemporalEase(i)),
          oe: easeList(prop.keyOutTemporalEase(i))
        };
        if (spatial) {
          key.it = clean(prop.keyInSpatialTangent(i));
          key.ot = clean(prop.keyOutSpatialTangent(i));
          try { if (prop.keyRoving(i)) key.rv = 1; } catch (e3) {}
        }
        out.k.push(key);
      }
      if (needsSampling(out.k, spatial, isColor)) sample = true;
    }
    if (hasExpr) {
      out.ex = 1;
      if (nk > 0 || expressionMoves(prop, env)) sample = true;
    }
    if (sample) out.s = sampleProp(prop, env);
    return out;
  }

  /** All vertices of a path as one flat list of numbers. */
  function flatVertices(shape) {
    var out = [], j, v = shape.vertices;
    for (j = 0; j < v.length; j++) {
      out.push(num(v[j][0]));
      out.push(num(v[j][1]));
    }
    return out;
  }

  function shapeMoves(prop, env) {
    var n = 12, i, first, v;
    first = flatVertices(prop.valueAtTime(0, false));
    for (i = 1; i <= n; i++) {
      v = flatVertices(prop.valueAtTime(env.comp.duration * i / n, false));
      if (differs(first, v)) return true;
    }
    return false;
  }

  /** Vertices per frame. Only for small paths that keep their number of points. */
  function sampleShape(prop, env, count) {
    var fd = env.comp.frameDuration;
    var n = Math.round(env.comp.duration / fd);
    var step = 1, frames = [], f, s;
    while (n / step > MAX_SAMPLES) step++;
    for (f = 0; f <= n; f += step) {
      s = prop.valueAtTime(f * fd, false);
      if (s.vertices.length !== count) return null;
      frames.push(flatVertices(s));
    }
    return { dt: fd * step, f: frames };
  }

  function dumpShapeValue(prop, env) {
    var nk = 0, hasExpr = false, moving = false, shape, out, s;
    if (!prop) return null;
    try { nk = prop.numKeys; } catch (e) { nk = 0; }
    try { hasExpr = prop.expressionEnabled && prop.expression !== ''; } catch (e2) { hasExpr = false; }
    shape = (nk > 0 || hasExpr) ? prop.valueAtTime(env.poster, false) : prop.value;
    out = {
      closed: shape.closed ? 1 : 0,
      v: [], i: [], o: []
    };
    var n = shape.vertices.length, j;
    for (j = 0; j < n; j++) {
      out.v.push(clean(shape.vertices[j]));
      out.i.push(clean(shape.inTangents[j]));
      out.o.push(clean(shape.outTangents[j]));
    }
    if (nk > 1) moving = true;
    else if (hasExpr) {
      try { moving = shapeMoves(prop, env); } catch (e3) { moving = false; }
    }
    if (moving) {
      out.anim = 1;
      if (n <= 16) {
        try { s = sampleShape(prop, env, n); } catch (e4) { s = null; }
        if (s) out.s = s;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- shapes

  function sub(group, name) {
    try { return group.property(name); } catch (e) { return null; }
  }

  function dumpDashes(stroke) {
    var d = sub(stroke, 'ADBE Vector Stroke Dashes'), out = [], i, p;
    if (!d) return null;
    for (i = 1; i <= d.numProperties; i++) {
      p = d.property(i);
      try {
        if (p.canSetExpression) out.push({ mn: p.matchName, v: num(p.value) });
      } catch (e) {}
    }
    return out.length ? out : null;
  }

  function dumpShapeItems(group, env) {
    var items = [], i, p, mn, it, tr;
    if (!group) return items;
    for (i = 1; i <= group.numProperties; i++) {
      p = group.property(i);
      if (tryGet(p, 'enabled') === false) continue;
      mn = p.matchName;
      it = { mn: mn, name: p.name };
      switch (mn) {
        case 'ADBE Vector Group':
          it.items = dumpShapeItems(sub(p, 'ADBE Vectors Group'), env);
          tr = sub(p, 'ADBE Vector Transform Group');
          if (tr) {
            it.tr = {
              a: dumpProp(sub(tr, 'ADBE Vector Anchor'), env),
              p: dumpProp(sub(tr, 'ADBE Vector Position'), env),
              s: dumpProp(sub(tr, 'ADBE Vector Scale'), env),
              r: dumpProp(sub(tr, 'ADBE Vector Rotation'), env),
              o: dumpProp(sub(tr, 'ADBE Vector Group Opacity'), env),
              sk: dumpProp(sub(tr, 'ADBE Vector Skew'), env)
            };
          }
          break;
        case 'ADBE Vector Shape - Rect':
          it.size = dumpProp(sub(p, 'ADBE Vector Rect Size'), env);
          it.pos = dumpProp(sub(p, 'ADBE Vector Rect Position'), env);
          it.round = dumpProp(sub(p, 'ADBE Vector Rect Roundness'), env);
          break;
        case 'ADBE Vector Shape - Ellipse':
          it.size = dumpProp(sub(p, 'ADBE Vector Ellipse Size'), env);
          it.pos = dumpProp(sub(p, 'ADBE Vector Ellipse Position'), env);
          break;
        case 'ADBE Vector Shape - Star':
          it.starType = dumpProp(sub(p, 'ADBE Vector Star Type'), env);
          it.points = dumpProp(sub(p, 'ADBE Vector Star Points'), env);
          it.pos = dumpProp(sub(p, 'ADBE Vector Star Position'), env);
          it.rot = dumpProp(sub(p, 'ADBE Vector Star Rotation'), env);
          it.inner = dumpProp(sub(p, 'ADBE Vector Star Inner Radius'), env);
          it.outer = dumpProp(sub(p, 'ADBE Vector Star Outer Radius'), env);
          it.innerRound = dumpProp(sub(p, 'ADBE Vector Star Inner Roundess'), env);
          it.outerRound = dumpProp(sub(p, 'ADBE Vector Star Outer Roundess'), env);
          break;
        case 'ADBE Vector Shape - Group':
          it.path = dumpShapeValue(sub(p, 'ADBE Vector Shape'), env);
          break;
        case 'ADBE Vector Graphic - Fill':
          it.color = dumpProp(sub(p, 'ADBE Vector Fill Color'), env);
          it.opacity = dumpProp(sub(p, 'ADBE Vector Fill Opacity'), env);
          it.rule = dumpProp(sub(p, 'ADBE Vector Fill Rule'), env);
          break;
        case 'ADBE Vector Graphic - Stroke':
          it.color = dumpProp(sub(p, 'ADBE Vector Stroke Color'), env);
          it.opacity = dumpProp(sub(p, 'ADBE Vector Stroke Opacity'), env);
          it.width = dumpProp(sub(p, 'ADBE Vector Stroke Width'), env);
          it.cap = dumpProp(sub(p, 'ADBE Vector Stroke Line Cap'), env);
          it.join = dumpProp(sub(p, 'ADBE Vector Stroke Line Join'), env);
          it.miter = dumpProp(sub(p, 'ADBE Vector Stroke Miter Limit'), env);
          it.dashes = dumpDashes(p);
          break;
        case 'ADBE Vector Graphic - G-Fill':
          it.opacity = dumpProp(sub(p, 'ADBE Vector Fill Opacity'), env);
          break;
        case 'ADBE Vector Graphic - G-Stroke':
          it.opacity = dumpProp(sub(p, 'ADBE Vector Stroke Opacity'), env);
          it.width = dumpProp(sub(p, 'ADBE Vector Stroke Width'), env);
          break;
        case 'ADBE Vector Filter - Trim':
          it.start = dumpProp(sub(p, 'ADBE Vector Trim Start'), env);
          it.end = dumpProp(sub(p, 'ADBE Vector Trim End'), env);
          it.offset = dumpProp(sub(p, 'ADBE Vector Trim Offset'), env);
          it.trimType = dumpProp(sub(p, 'ADBE Vector Trim Type'), env);
          break;
        case 'ADBE Vector Filter - RC':
          it.radius = dumpProp(sub(p, 'ADBE Vector RoundCorner Radius'), env);
          break;
        case 'ADBE Vector Filter - Merge':
          it.mode = dumpProp(sub(p, 'ADBE Vector Merge Type'), env);
          break;
        default:
          break;
      }
      items.push(it);
    }
    return items;
  }

  // ------------------------------------------------------------------ text

  function dumpText(layer, env) {
    var tp = layer.property('ADBE Text Properties');
    var docProp = tp.property('ADBE Text Document');
    var td, out = {}, anim, r, v;
    try { td = docProp.valueAtTime(env.poster, false); } catch (e) { td = docProp.value; }

    out.text = String(tryGet(td, 'text') || '');
    out.font = tryGet(td, 'font') || '';
    out.family = tryGet(td, 'fontFamily') || '';
    out.style = tryGet(td, 'fontStyle') || '';
    out.size = num(tryGet(td, 'fontSize'));
    if (tryGet(td, 'applyFill')) out.fill = clean(tryGet(td, 'fillColor'));
    if (tryGet(td, 'applyStroke')) {
      out.stroke = clean(tryGet(td, 'strokeColor'));
      out.strokeWidth = num(tryGet(td, 'strokeWidth'));
    }
    v = tryGet(td, 'justification');
    out.justify = v !== undefined ? justifyName(v) : 'left';
    out.tracking = num(tryGet(td, 'tracking'));
    v = tryGet(td, 'leading');
    if (typeof v === 'number') out.leading = num(v);
    if (tryGet(td, 'boxText')) {
      out.box = 1;
      out.boxSize = clean(tryGet(td, 'boxTextSize'));
      out.boxPos = clean(tryGet(td, 'boxTextPos'));
    }
    v = tryGet(td, 'baselineLocs');
    if (v) out.baselines = clean(v);
    if (tryGet(td, 'allCaps')) out.allCaps = 1;
    if (tryGet(td, 'smallCaps')) out.smallCaps = 1;

    try { out.textKeys = docProp.numKeys; } catch (e2) { out.textKeys = 0; }
    try {
      anim = tp.property('ADBE Text Animators');
      out.animators = anim ? anim.numProperties : 0;
    } catch (e3) { out.animators = 0; }
    try {
      r = layer.sourceRectAtTime(env.poster, false);
      out.rect = [num(r.left), num(r.top), num(r.width), num(r.height)];
    } catch (e4) {}
    return out;
  }

  // ---------------------------------------------------------------- layers

  function dumpFootage(item, ctx) {
    var id = String(item.id), f, src;
    if (ctx.footage[id]) return id;
    f = { id: id, name: item.name, w: item.width, h: item.height };
    src = item.mainSource;
    if (src instanceof SolidSource) {
      f.solid = clean(src.color);
    } else if (src instanceof FileSource) {
      f.still = src.isStill ? 1 : 0;
      try { f.file = src.file ? src.file.fsName : null; } catch (e) { f.file = null; }
      if (tryGet(item, 'footageMissing')) f.missing = 1;
    } else {
      f.placeholder = 1;
    }
    ctx.footage[id] = f;
    return id;
  }

  /** True when `text` contains `part`. (String.indexOf exists in ES3, but keeping to split keeps the ES3 scan simple.) */
  function contains(text, part) {
    return String(text).split(part).length > 1;
  }

  /** `name` written as a string literal somewhere in an expression. */
  function mentions(text, name) {
    return contains(text, '"' + name + '"') || contains(text, "'" + name + "'");
  }

  function sigOf(v) {
    var i, parts;
    if (typeof v === 'number') return String(Math.round(v * 10000) / 10000);
    if (v instanceof Array) {
      parts = [];
      for (i = 0; i < v.length; i++) parts.push(String(Math.round(v[i] * 10000) / 10000));
      return parts.join(',');
    }
    return '';
  }

  // ------------------------------------------------------ temporary changes

  var UNDO_NAME = 'Motion Bridge: read template options';

  /**
   * Reading what a template looks like with another option means switching
   * that option in After Effects for a moment: the value is set, the result
   * is read, and the value is put back. Every such change goes through here,
   * so it is always put back - also when something fails in between.
   */
  function setTemp(prop, value, ctx) {
    var before;
    try {
      before = prop.valueAtTime(0, true);
      if (!ctx.undoOpen) {
        app.beginUndoGroup(UNDO_NAME);
        ctx.undoOpen = true;
      }
      prop.setValue(value);
      ctx.changed.push({ p: prop, v: before });
      return true;
    } catch (e) {
      return false;
    }
  }

  function restoreTo(ctx, mark) {
    var c;
    while (ctx.changed.length > mark) {
      c = ctx.changed.pop();
      try {
        c.p.setValue(c.v);
      } catch (e) {
        ctx.warnings.push({ message: 'A template option could not be put back to its original value (' + String(e) + '). Use Edit > Undo in After Effects.' });
      }
    }
  }

  /**
   * Ends a read: everything is put back, and the step is taken out of the
   * undo list again so nobody has to wonder what "read template options" is.
   * Edit > Undo is only used when this script has just closed its own undo
   * step with changes in it, so that step is the one on top; afterwards every
   * value is checked and, if need be, put back by hand.
   */
  function closeChanges(ctx) {
    var i, c, now, undone = false;
    if (ctx.undoOpen) {
      try { app.endUndoGroup(); } catch (e1) {}
      ctx.undoOpen = false;
      try {
        app.executeCommand(16);
        undone = true;
      } catch (e2) {}
    }
    for (i = ctx.changed.length - 1; i >= 0; i--) {
      c = ctx.changed[i];
      try {
        now = c.p.valueAtTime(0, true);
        if (differs(clean(now), clean(c.v))) c.p.setValue(c.v);
      } catch (e3) {
        // After the undo the value is back even when it can no longer be checked.
        if (!undone) {
          ctx.warnings.push({ message: 'A template option could not be put back to its original value (' + String(e3) + '). Use Edit > Undo in After Effects.' });
        }
      }
    }
    ctx.changed = [];
  }

  // -------------------------------------------------- options and overrides

  /** A property with a small whole-number range: a menu, a checkbox, a popup. */
  function enumRange(prop) {
    var min, max;
    try {
      if (prop.propertyType !== PropertyType.PROPERTY) return null;
      if (prop.propertyValueType !== PropertyValueType.OneD) return null;
      if (!prop.hasMin || !prop.hasMax) return null;
      min = prop.minValue;
      max = prop.maxValue;
      if (min !== Math.round(min) || max !== Math.round(max)) return null;
      if (max - min < 1 || max - min > 63) return null;
      return { min: min, max: max };
    } catch (e) {
      return null;
    }
  }

  function hasExpression(prop) {
    try {
      return !!(prop.canSetExpression && prop.expressionEnabled && prop.expression !== '');
    } catch (e) {
      return false;
    }
  }

  /** Every property below `group` that carries an active expression. */
  function collectExprProps(group, out, depth) {
    var i, p;
    if (depth > 14) return;
    for (i = 1; i <= group.numProperties; i++) {
      try { p = group.property(i); } catch (e) { continue; }
      if (!p) continue;
      if (p.propertyType === PropertyType.PROPERTY) {
        if (hasExpression(p)) out.push(p);
      } else {
        collectExprProps(p, out, depth + 1);
      }
    }
  }

  /**
   * The values a layer gets through Essential Properties (the controls a
   * nested composition exposes). `src` is the property inside the nested
   * composition that the control stands for.
   */
  function collectOverrides(group, env, out, depth) {
    var T = PropertyValueType, i, p, pvt, o, v, a, b, src;
    if (depth > 6) return;
    for (i = 1; i <= group.numProperties; i++) {
      try { p = group.property(i); } catch (e1) { continue; }
      if (!p) continue;
      if (p.propertyType !== PropertyType.PROPERTY) {
        collectOverrides(p, env, out, depth + 1);
        continue;
      }
      pvt = p.propertyValueType;
      o = { name: p.name };
      if (pvt === T.TEXT_DOCUMENT) {
        try { o.text = String(p.valueAtTime(env.poster, false).text); } catch (e2) { continue; }
      } else if (pvt === T.OneD || pvt === T.TwoD || pvt === T.ThreeD || pvt === T.TwoD_SPATIAL || pvt === T.ThreeD_SPATIAL || pvt === T.COLOR) {
        try { v = clean(p.valueAtTime(env.poster, false)); } catch (e3) { continue; }
        if (v === null) continue;
        o.v = v;
        try {
          a = clean(p.valueAtTime(0, false));
          b = clean(p.valueAtTime(Math.max(0, env.comp.duration - env.comp.frameDuration), false));
          if (differs(a, v) || differs(b, v)) o.varies = 1;
        } catch (e4) {}
        if (enumRange(p)) o.menu = 1;
      } else {
        continue;
      }
      try { src = p.essentialPropertySource; } catch (e5) { src = null; }
      try {
        o.src = (src && src.propertyType === PropertyType.PROPERTY) ? src : null;
      } catch (e6) {
        o.src = null;
      }
      out.push(o);
    }
  }

  function readOverrides(layer, env) {
    var out = [], g;
    try { g = layer.property('ADBE Layer Overrides'); } catch (e) { g = null; }
    if (g && g.numProperties) collectOverrides(g, env, out, 0);
    return out;
  }

  // ---------------------------------------------------------------- layers

  var CONTROL_EFFECTS = {
    'ADBE Slider Control': 1,
    'ADBE Checkbox Control': 1,
    'ADBE Color Control': 1,
    'ADBE Point Control': 1,
    'ADBE Point3D Control': 1,
    'ADBE Angle Control': 1,
    'ADBE Layer Control': 1,
    'ADBE Dropdown Control': 1
  };

  /** Effects that change the picture. Expression controls and control rigs only hold values. */
  function dumpEffects(layer, env) {
    var fx, out = [], i, e, mn, it;
    try { fx = layer.property('ADBE Effect Parade'); } catch (e1) { fx = null; }
    if (!fx) return out;
    for (i = 1; i <= fx.numProperties; i++) {
      e = fx.property(i);
      if (tryGet(e, 'enabled') === false) continue;
      mn = e.matchName;
      if (CONTROL_EFFECTS[mn] || mn.substring(0, 7) === 'Pseudo/') continue;
      it = { name: e.name, mn: mn };
      if (mn === 'ADBE Drop Shadow') {
        it.p = {
          color: dumpProp(sub(e, 'ADBE Drop Shadow-0001'), env),
          opacity: dumpProp(sub(e, 'ADBE Drop Shadow-0002'), env),
          direction: dumpProp(sub(e, 'ADBE Drop Shadow-0003'), env),
          distance: dumpProp(sub(e, 'ADBE Drop Shadow-0004'), env),
          softness: dumpProp(sub(e, 'ADBE Drop Shadow-0005'), env),
          only: dumpProp(sub(e, 'ADBE Drop Shadow-0006'), env)
        };
        // Scripts see this opacity on a 0-255 scale; pass the top of the scale along.
        try { it.omax = num(sub(e, 'ADBE Drop Shadow-0002').maxValue); } catch (e2) { it.omax = 255; }
      }
      out.push(it);
    }
    return out;
  }

  function matteName(t) {
    var M = TrackMatteType;
    if (t === M.ALPHA) return 'a';
    if (t === M.ALPHA_INVERTED) return 'ai';
    if (t === M.LUMA) return 'l';
    if (t === M.LUMA_INVERTED) return 'li';
    return '';
  }

  function dumpLayer(layer, env, ctx) {
    var mn = layer.matchName;
    var on = layer.enabled;
    var L = {
      index: layer.index,
      name: layer.name,
      enabled: on ? 1 : 0,
      inPoint: num(layer.inPoint),
      outPoint: num(layer.outPoint),
      startTime: num(layer.startTime),
      stretch: num(layer.stretch),
      parent: layer.parent ? layer.parent.index : null
    };
    var type = 'other', tg, pos, fid, masks, mt, ml, ovs, i, srcPoster, never;

    if (mn === 'ADBE Camera Layer') type = 'camera';
    else if (mn === 'ADBE Light Layer') type = 'light';
    else if (mn === 'ADBE Vector Layer') type = 'shape';
    else if (mn === 'ADBE Text Layer') type = 'text';
    else if (mn === 'ADBE AV Layer') {
      if (layer.nullLayer) type = 'null';
      else if (layer.source instanceof CompItem) type = 'precomp';
      else if (layer.source instanceof FootageItem) {
        fid = dumpFootage(layer.source, ctx);
        type = ctx.footage[fid].solid ? 'solid' : 'footage';
        L.src = fid;
      }
    }
    L.type = type;
    if (type === 'camera' || type === 'light' || type === 'other') return L;

    L.w = tryGet(layer, 'width') || 0;
    L.h = tryGet(layer, 'height') || 0;
    if (tryGet(layer, 'hasVideo') === false) L.noVideo = 1;
    if (tryGet(layer, 'guideLayer')) L.guide = 1;
    if (tryGet(layer, 'adjustmentLayer')) L.adjustment = 1;
    if (tryGet(layer, 'threeDLayer')) L.threeD = 1;
    if (tryGet(layer, 'timeRemapEnabled')) L.timeRemap = 1;
    if (tryGet(layer, 'collapseTransformation')) L.collapse = 1;
    if (tryGet(layer, 'isTrackMatte')) L.isMatte = 1;
    try {
      // The matte layer itself also reports a matte type, so ask whether this layer *has* one.
      mt = layer.hasTrackMatte ? matteName(layer.trackMatteType) : '';
      if (mt) {
        ml = tryGet(layer, 'trackMatteLayer');
        L.matte = { i: ml ? ml.index : layer.index - 1, t: mt };
      }
    } catch (e1) {}
    try { L.blend = blendName(layer.blendingMode); } catch (e2) { L.blend = 'normal'; }
    L.fx = dumpEffects(layer, env);
    try {
      masks = layer.property('ADBE Mask Parade');
      L.masks = masks ? masks.numProperties : 0;
    } catch (e3) { L.masks = 0; }

    tg = layer.property('ADBE Transform Group');
    pos = tg.property('ADBE Position');
    L.tr = {
      a: dumpProp(tg.property('ADBE Anchor Point'), env),
      s: dumpProp(tg.property('ADBE Scale'), env),
      r: dumpProp(tg.property('ADBE Rotate Z'), env),
      o: dumpProp(tg.property('ADBE Opacity'), env)
    };
    if (tryGet(pos, 'dimensionsSeparated')) {
      L.tr.px = dumpProp(tg.property('ADBE Position_0'), env);
      L.tr.py = dumpProp(tg.property('ADBE Position_1'), env);
    } else {
      L.tr.p = dumpProp(pos, env);
    }

    // A layer nobody ever sees (switched off, a guide, or held at zero opacity
    // by a template option) keeps its transform, because other layers may
    // follow it, but its content is not read. This is what keeps a template
    // with twenty alternative logos from being read twenty times over.
    never = L.tr.o && !L.tr.o.k && !L.tr.o.s && typeof L.tr.o.v === 'number' && L.tr.o.v <= 0;
    if ((!on || L.guide || never) && !L.isMatte) {
      L.skip = 1;
      return L;
    }

    if (type === 'precomp') {
      srcPoster = env.poster - layer.startTime;
      if (L.timeRemap) {
        L.remap = dumpProp(layer.property('ADBE Time Remapping'), env);
        if (L.remap && typeof L.remap.v === 'number') srcPoster = L.remap.v;
      }
      ovs = readOverrides(layer, env);
      for (i = 0; i < ovs.length; i++) {
        if (ovs[i].varies) {
          ctx.warnings.push({
            comp: env.comp.name,
            layer: layer.name,
            message: 'The control "' + ovs[i].name + '" changes over time; its value at the current frame is used for the whole animation.'
          });
        }
      }
      L.src = dumpContext(layer.source, ovs, ctx, srcPoster, { comp: env.comp.name, layer: layer.name });
    } else if (type === 'shape') {
      L.shape = dumpShapeItems(layer.property('ADBE Root Vectors Group'), env);
    } else if (type === 'text') {
      L.text = dumpText(layer, env);
    }
    return L;
  }

  function dumpLayers(comp, env, ctx, into) {
    var i, layer;
    for (i = 1; i <= comp.numLayers; i++) {
      layer = comp.layer(i);
      try {
        into.push(dumpLayer(layer, env, ctx));
      } catch (e) {
        ctx.warnings.push({
          comp: comp.name,
          layer: layer.name,
          message: 'Could not read this layer: ' + String(e) + (e && e.line ? ' (line ' + e.line + ')' : '')
        });
      }
    }
  }

  function clampPoster(comp, poster) {
    if (!(poster > 0)) return 0;
    if (poster > comp.duration - comp.frameDuration) return Math.max(0, comp.duration - comp.frameDuration);
    return poster;
  }

  /**
   * Reads a composition the way one particular layer shows it: with that
   * layer's control values (Essential Properties) switched in. The same
   * composition with other control values is a different entry, so each
   * combination is read once. Without controls the key is just the comp id.
   */
  function dumpContext(comp, ovs, ctx, poster, where) {
    var sig = '', eps = [], i, o, full, key, c, env, mark, cur;
    for (i = 0; i < ovs.length; i++) {
      o = ovs[i];
      if (o.v !== undefined) {
        sig += o.name + '=' + sigOf(o.v) + ';';
        eps.push({ name: o.name, v: o.v, menu: o.menu });
      } else if (o.text !== undefined) {
        eps.push({ name: o.name, text: o.text });
      }
    }
    key = String(comp.id);
    if (sig) {
      full = key + '|' + sig;
      if (!ctx.keys[full]) {
        ctx.keyCount++;
        ctx.keys[full] = key + '~' + ctx.keyCount;
      }
      key = ctx.keys[full];
    }
    if (ctx.comps[key]) return key;

    poster = clampPoster(comp, poster);
    c = {
      id: key,
      cid: String(comp.id),
      name: comp.name,
      w: comp.width,
      h: comp.height,
      duration: num(comp.duration),
      frameRate: num(comp.frameRate),
      bg: clean(comp.bgColor),
      layers: []
    };
    if (eps.length) c.ep = eps;
    ctx.comps[key] = c;
    ctx.fresh.push(key);

    mark = ctx.changed.length;
    try {
      for (i = 0; i < ovs.length; i++) {
        o = ovs[i];
        if (!o.src || o.v === undefined) continue;
        try { cur = clean(o.src.valueAtTime(poster, true)); } catch (e1) { continue; }
        if (!differs(cur, o.v)) continue;
        if (o.src.numKeys > 0 || !setTemp(o.src, o.v, ctx)) {
          ctx.warnings.push({
            comp: where ? where.comp : comp.name,
            layer: where ? where.layer : undefined,
            message: 'The control "' + o.name + '" could not be applied; the composition "' + comp.name + '" is shown with its own setting.'
          });
        }
      }
      env = { comp: comp, poster: poster };
      dumpLayers(comp, env, ctx, c.layers);
    } finally {
      restoreTo(ctx, mark);
    }
    return key;
  }

  // ------------------------------------------------------ template options

  /**
   * Finds the controls of a composition that work as template options: menus
   * and checkboxes on a layer's effects that other layers read through
   * expressions (directly, or through another control on the same layer).
   */
  function findControllers(comp) {
    var cands = [], exprs = [], i, j, k, m, layer, fx, e, p, r, props, texts, count, c, d, changed, text, hit;
    for (i = 1; i <= comp.numLayers; i++) {
      layer = comp.layer(i);
      props = [];
      texts = [];
      try { collectExprProps(layer, props, 0); } catch (e0) {}
      for (j = 0; j < props.length; j++) {
        try { texts.push(props[j].expression); } catch (e1) {}
      }
      exprs[i] = texts;
      try { fx = layer.property('ADBE Effect Parade'); } catch (e2) { fx = null; }
      if (!fx) continue;
      for (j = 1; j <= fx.numProperties; j++) {
        e = fx.property(j);
        if (tryGet(e, 'enabled') === false) continue;
        count = 0;
        props = [];
        for (k = 1; k <= e.numProperties; k++) {
          try { p = e.property(k); } catch (e3) { continue; }
          r = enumRange(p);
          if (!r) continue;
          count++;
          props.push({
            id: i + '.' + j + '.' + k,
            li: i, ei: j, pi: k,
            layer: layer.name,
            effect: e.name,
            prop: p.name,
            mn: p.matchName,
            min: r.min,
            max: r.max,
            value: Math.round(p.value),
            menu: tryGet(p, 'isDropdownEffect') ? 1 : 0,
            derived: hasExpression(p) ? 1 : 0,
            keyed: p.numKeys > 0 ? 1 : 0,
            ex: hasExpression(p) ? p.expression : '',
            used: 0
          });
        }
        for (k = 0; k < props.length; k++) {
          props[k].single = count === 1 ? 1 : 0;
          cands.push(props[k]);
        }
      }
    }

    function refers(text, c2) {
      if (!mentions(text, c2.effect)) return false;
      return c2.single || mentions(text, c2.prop) || mentions(text, c2.mn);
    }

    do {
      changed = false;
      for (i = 0; i < cands.length; i++) {
        c = cands[i];
        if (c.used) continue;
        hit = false;
        // Read by another layer?
        for (j = 1; j <= comp.numLayers && !hit; j++) {
          if (j === c.li) continue;
          texts = exprs[j] || [];
          for (m = 0; m < texts.length && !hit; m++) {
            text = texts[m];
            if (mentions(text, c.layer) && refers(text, c)) hit = true;
          }
        }
        // Or by a control on the same layer that is itself read by others?
        for (j = 0; j < cands.length && !hit; j++) {
          d = cands[j];
          if (d === c || d.li !== c.li || !d.used || !d.derived) continue;
          if (refers(d.ex, c)) hit = true;
        }
        if (hit) {
          c.used = 1;
          changed = true;
        }
      }
    } while (changed);

    props = [];
    for (i = 0; i < cands.length; i++) {
      c = cands[i];
      if (!c.used || c.derived || c.keyed) continue;
      props.push({
        id: c.id,
        layer: c.layer,
        name: c.effect,
        prop: c.prop,
        kind: c.menu ? 'menu' : (c.max - c.min === 1 && c.min === 0 ? 'checkbox' : 'menu'),
        min: c.min,
        max: c.max,
        value: c.value
      });
    }
    return props;
  }

  function controllerProp(comp, id) {
    var parts = String(id).split('.');
    try {
      return comp.layer(Number(parts[0])).property('ADBE Effect Parade').property(Number(parts[1])).property(Number(parts[2]));
    } catch (e) {
      return null;
    }
  }

  function valueSignature(prop, v) {
    var T = PropertyValueType, t = prop.propertyValueType;
    if (t === T.TEXT_DOCUMENT) return String(v.text);
    if (t === T.SHAPE) return flatVertices(v).join(',');
    if (typeof v === 'number' || v instanceof Array) return sigOf(v);
    return '';
  }

  /**
   * A short summary of everything on a layer that an expression decides.
   * When it is the same for two template options, the layer does not depend
   * on the option and does not have to be read again.
   */
  function fingerprint(layer, comp) {
    var props = [], parts = [], d = comp.duration, fd = comp.frameDuration, times, i, j;
    collectExprProps(layer, props, 0);
    if (!props.length) return '';
    times = [0, d * 0.23, d * 0.5, d * 0.77, Math.max(0, d - fd)];
    for (i = 0; i < props.length; i++) {
      for (j = 0; j < times.length; j++) {
        try {
          parts.push(valueSignature(props[i], props[i].valueAtTime(times[j], false)));
        } catch (e) {
          parts.push('?');
        }
      }
    }
    return parts.join('|');
  }

  function newContext() {
    return { comps: {}, footage: {}, warnings: [], keys: {}, keyCount: 0, changed: [], undoOpen: false, fresh: [], sentFootage: {} };
  }

  /** What was read since the last answer: the panel puts the pieces together. */
  function takeFresh(ctx) {
    var out = { comps: {}, footage: {}, warnings: ctx.warnings }, i, k;
    for (i = 0; i < ctx.fresh.length; i++) out.comps[ctx.fresh[i]] = ctx.comps[ctx.fresh[i]];
    for (k in ctx.footage) {
      if (ctx.footage.hasOwnProperty(k) && !ctx.sentFootage[k]) {
        out.footage[k] = ctx.footage[k];
        ctx.sentFootage[k] = 1;
      }
    }
    ctx.fresh = [];
    ctx.warnings = [];
    return out;
  }

  var session = null;

  /** The composition to work on: the one named by id, else the active one. */
  function pickComp(compId) {
    var item = null;
    if (!app.project) return null;
    if (compId !== undefined && compId !== null) {
      try { item = app.project.itemByID(Number(compId)); } catch (e) { item = null; }
    } else {
      item = app.project.activeItem;
    }
    return (item && item instanceof CompItem) ? item : null;
  }

  /** The project file's name as the user sees it (After Effects hands it over URL-encoded). */
  function projectName() {
    var name;
    if (!app.project || !app.project.file) return null;
    name = app.project.file.name;
    try { return decodeURI(name); } catch (e) { return name; }
  }

  function fail(code, message, e) {
    return stringify({ ok: false, error: code, message: message, line: e && e.line ? e.line : undefined });
  }

  // ------------------------------------------------------------ public API

  var api = {};

  api.version = VERSION;

  api.ping = function () {
    return 'pong';
  };

  api.getStatus = function () {
    try {
      var item = app.project ? app.project.activeItem : null;
      var out = { ok: true, ae: app.version }, sel, i;
      out.project = projectName();
      // Changes when compositions come and go, so the panel knows when to list them again.
      out.items = app.project ? app.project.numItems : 0;
      if (item && item instanceof CompItem) {
        out.comp = { id: String(item.id), name: item.name, w: item.width, h: item.height, layers: item.numLayers, duration: num(item.duration), time: num(item.time) };
      } else {
        out.comp = null;
      }
      // With no timeline in front, the compositions picked in the Project panel are "the selected item".
      out.picked = [];
      try {
        sel = app.project ? app.project.selection : [];
        for (i = 0; i < sel.length && out.picked.length < 64; i++) {
          if (sel[i] instanceof CompItem) {
            out.picked.push({ id: String(sel[i].id), name: sel[i].name, w: sel[i].width, h: sel[i].height, layers: sel[i].numLayers, duration: num(sel[i].duration) });
          }
        }
      } catch (e0) {}
      return stringify(out);
    } catch (e) {
      return fail('EXCEPTION', String(e), e);
    }
  };

  /**
   * Every composition of the project, for choosing several to send at once.
   * `nested` marks the ones used inside another composition: those are
   * building blocks rather than deliverables.
   */
  api.listComps = function () {
    try {
      var out = [], i, item, used, folder, active;
      if (!app.project) return stringify({ ok: true, active: null, comps: [] });
      active = app.project.activeItem;
      for (i = 1; i <= app.project.numItems; i++) {
        item = app.project.item(i);
        if (!(item instanceof CompItem)) continue;
        used = 0;
        try { used = item.usedIn.length; } catch (e1) { used = 0; }
        folder = '';
        try {
          if (item.parentFolder && item.parentFolder !== app.project.rootFolder) folder = item.parentFolder.name;
        } catch (e2) { folder = ''; }
        out.push({
          id: String(item.id),
          name: item.name,
          w: item.width,
          h: item.height,
          duration: num(item.duration),
          layers: item.numLayers,
          nested: used > 0 ? 1 : 0,
          folder: folder
        });
      }
      return stringify({
        ok: true,
        active: (active && active instanceof CompItem) ? String(active.id) : null,
        comps: out
      });
    } catch (e) {
      return fail('EXCEPTION', String(e), e);
    }
  };

  /** The template options of a composition (see findControllers). */
  api.listControllers = function (compId) {
    try {
      var comp = pickComp(compId);
      if (!comp) return stringify({ ok: true, comp: null, controllers: [] });
      return stringify({ ok: true, comp: String(comp.id), controllers: findControllers(comp) });
    } catch (e) {
      return fail('EXCEPTION', String(e), e);
    }
  };

  /**
   * Reads the active composition and every composition nested inside it, as
   * it is set up right now. `ids` names the template options (from
   * listControllers) whose other settings should be read as well; the answer
   * lists those settings as `states`, to be fetched one by one with
   * exportState. Nested compositions are read with the control values of the
   * layer that shows them, which means switching those controls for a moment
   * (see setTemp); everything is put back before this returns.
   *
   * `poster` is the time whose look becomes the static design. Left out, it
   * is where the playhead is; an update names the time the design was built
   * with, so that moving the playhead does not change the design.
   */
  api.beginExport = function (ids, compId, poster) {
    var ctx = newContext();
    try {
      var comp = pickComp(compId);
      var controllers = [], states = [], base = [], i, j, k, p, r, c, env, rootId, root, fps = {}, next, combos, out;
      if (!comp) {
        return fail('NO_COMP', 'Open the composition you want to send and click into its timeline first.');
      }
      if (typeof poster !== 'number' || !isFinite(poster) || poster < 0) poster = comp.time;
      poster = clampPoster(comp, poster);
      ids = ids || [];
      for (i = 0; i < ids.length; i++) {
        p = controllerProp(comp, ids[i]);
        r = p ? enumRange(p) : null;
        if (!r) continue;
        c = {
          id: String(ids[i]),
          name: p.parentProperty.name,
          layer: comp.layer(Number(String(ids[i]).split('.')[0])).name,
          min: r.min,
          max: r.max,
          value: Math.round(p.value)
        };
        controllers.push(c);
        base.push(c.value);
      }
      // Every combination of the chosen options, except the one that is set right now.
      combos = [[]];
      for (i = 0; i < controllers.length; i++) {
        next = [];
        for (j = 0; j < combos.length; j++) {
          for (k = controllers[i].min; k <= controllers[i].max; k++) next.push(combos[j].concat([k]));
        }
        combos = next;
      }
      for (i = 0; i < combos.length; i++) {
        if (controllers.length && combos[i].join(',') !== base.join(',')) states.push(combos[i]);
      }

      rootId = dumpContext(comp, [], ctx, poster, null);
      root = ctx.comps[rootId];
      if (states.length) {
        for (i = 1; i <= comp.numLayers; i++) {
          try { fps[i] = fingerprint(comp.layer(i), comp); } catch (e1) { fps[i] = ''; }
        }
      }
      closeChanges(ctx);

      session = { compId: comp.id, ctx: ctx, controllers: controllers, states: states, fps: fps, poster: poster };
      out = takeFresh(ctx);
      return stringify({
        ok: true,
        data: {
          host: VERSION,
          ae: app.version,
          project: projectName(),
          rootId: rootId,
          poster: num(poster),
          comps: out.comps,
          footage: out.footage,
          warnings: out.warnings,
          controllers: controllers,
          base: base,
          pending: states
        }
      });
    } catch (e) {
      try { closeChanges(ctx); } catch (e2) {}
      return fail('EXCEPTION', String(e), e);
    }
  };

  /**
   * Reads the composition with template option setting number `index` (from
   * beginExport's `pending` list). Layers that do not depend on the options
   * come back as null: they are the same as in the first read.
   */
  api.exportState = function (index) {
    var ctx = session ? session.ctx : null;
    try {
      var comp, values, i, p, layers = [], env, layer, fp, out;
      if (!session) return fail('NO_SESSION', 'Start again: the composition was not read yet.');
      comp = app.project.itemByID(session.compId);
      values = session.states[index];
      if (!comp || !(comp instanceof CompItem) || !values) return fail('NO_COMP', 'The composition is no longer available.');

      for (i = 0; i < session.controllers.length; i++) {
        p = controllerProp(comp, session.controllers[i].id);
        if (!p) return fail('NO_CONTROL', 'A template option is no longer where it was. Read the composition again.');
        if (Math.round(p.value) !== values[i] && !setTemp(p, values[i], ctx)) {
          closeChanges(ctx);
          return fail('LOCKED', 'The option "' + session.controllers[i].name + '" could not be switched (is its layer locked?).');
        }
      }
      env = { comp: comp, poster: session.poster };
      for (i = 1; i <= comp.numLayers; i++) {
        layer = comp.layer(i);
        try { fp = fingerprint(layer, comp); } catch (e1) { fp = ''; }
        if (fp === (session.fps[i] || '')) {
          layers.push(null);
          continue;
        }
        try {
          layers.push(dumpLayer(layer, env, ctx));
        } catch (e2) {
          layers.push(null);
          ctx.warnings.push({ comp: comp.name, layer: layer.name, message: 'Could not read this layer for one of the options: ' + String(e2) });
        }
      }
      closeChanges(ctx);
      out = takeFresh(ctx);
      return stringify({
        ok: true,
        data: { index: index, values: values, layers: layers, comps: out.comps, footage: out.footage, warnings: out.warnings }
      });
    } catch (e) {
      try { if (ctx) closeChanges(ctx); } catch (e3) {}
      return fail('EXCEPTION', String(e), e);
    }
  };

  api.endExport = function () {
    session = null;
    return stringify({ ok: true });
  };

  /** Reads the active composition as it is set up right now. */
  api.exportActiveComp = function () {
    return api.beginExport([]);
  };

  /**
   * Renders one frame of a footage item to a PNG. Used for sources Figma
   * cannot read directly (PSD, AI, video ...). A temporary composition is
   * created and removed again.
   */
  api.renderFootage = function (itemId, time, outPath) {
    var tmp = null, opened = false;
    try {
      var item = app.project.itemByID(Number(itemId));
      var file = new File(outPath);
      var waited = 0;
      if (!item) return fail('NO_ITEM', 'Footage item not found.');
      if (file.exists) file.remove();
      app.beginUndoGroup('Motion Bridge: render still');
      opened = true;
      tmp = app.project.items.addComp('Motion Bridge (temporary)', Math.max(4, item.width), Math.max(4, item.height), 1, Math.max(1, time + 1), 30);
      tmp.layers.add(item);
      tmp.saveFrameToPng(Math.max(0, time), file);
      while ((!file.exists || file.length === 0) && waited < 15000) {
        $.sleep(100);
        waited += 100;
      }
      tmp.remove();
      tmp = null;
      app.endUndoGroup();
      opened = false;
      if (!file.exists) return fail('RENDER_FAILED', 'After Effects did not write the image.');
      return stringify({ ok: true, path: file.fsName });
    } catch (e) {
      try { if (tmp) tmp.remove(); } catch (e2) {}
      try { if (opened) app.endUndoGroup(); } catch (e3) {}
      return fail('EXCEPTION', String(e), e);
    }
  };

  api.pickSavePath = function (defaultName) {
    try {
      var start = new File(Folder.desktop.fsName + '/' + defaultName);
      var file = start.saveDlg('Save transfer file');
      return stringify({ ok: true, path: file ? file.fsName : null });
    } catch (e) {
      return fail('EXCEPTION', String(e), e);
    }
  };

  // ------------------------------------------------- building from a plan
  //
  // The other direction: Figma frames become compositions. The panel turns
  // the transfer into a build plan (shared/ae-build.ts) and this part only
  // carries it out: add this layer, set that property, put these keys on it.

  function readPlan(path) {
    var f = new File(path), text;
    f.encoding = 'UTF-8';
    if (!f.open('r')) throw new Error('The build plan could not be opened (' + path + ').');
    text = f.read();
    f.close();
    // The panel writes this file itself, as plain ASCII JSON; ExtendScript has no JSON parser.
    return eval('(' + text + ')');
  }

  function blendValue(name) {
    var B = BlendingMode;
    switch (name) {
      case 'darken': return B.DARKEN;
      case 'multiply': return B.MULTIPLY;
      case 'color-burn': return B.COLOR_BURN;
      case 'linear-burn': return B.LINEAR_BURN;
      case 'lighten': return B.LIGHTEN;
      case 'screen': return B.SCREEN;
      case 'color-dodge': return B.COLOR_DODGE;
      case 'linear-dodge': return B.LINEAR_DODGE;
      case 'overlay': return B.OVERLAY;
      case 'soft-light': return B.SOFT_LIGHT;
      case 'hard-light': return B.HARD_LIGHT;
      case 'difference': return B.DIFFERENCE;
      case 'exclusion': return B.EXCLUSION;
      case 'hue': return B.HUE;
      case 'saturation': return B.SATURATION;
      case 'color': return B.COLOR;
      case 'luminosity': return B.LUMINOSITY;
      default: return B.NORMAL;
    }
  }

  function interpValue(n) {
    if (n === 'h') return KeyframeInterpolationType.HOLD;
    if (n === 'b') return KeyframeInterpolationType.BEZIER;
    return KeyframeInterpolationType.LINEAR;
  }

  /**
   * As many KeyframeEase objects as the property has ease dimensions, whatever
   * the plan brought. A dimension the plan does not know (the Z of a 2D
   * layer's scale) gets a flat ease: its value never changes, and a speed on a
   * value that stands still is what makes a later read sample the property.
   */
  function easeObjects(list, count) {
    var out = [], i, e;
    for (i = 0; i < count; i++) {
      e = list[i] || { s: 0, i: 16.667 };
      out.push(new KeyframeEase(e.s, Math.max(0.1, Math.min(100, e.i))));
    }
    return out;
  }

  function isSpatialProp(prop) {
    var t;
    try {
      t = prop.propertyValueType;
      return t === PropertyValueType.TwoD_SPATIAL || t === PropertyValueType.ThreeD_SPATIAL;
    } catch (e) {
      return false;
    }
  }

  /** Sets a property to a value, or puts the plan's keys on it with their easing. */
  function applyProp(prop, pp, st) {
    var i, k, idx, count, spatial, zero;
    if (!prop || !pp) return;
    if (!pp.k || pp.k.length < 2) {
      prop.setValue(pp.v);
      return;
    }
    for (i = 0; i < pp.k.length; i++) prop.setValueAtTime(pp.k[i].t, pp.k[i].v);
    spatial = isSpatialProp(prop);
    zero = (spatial && prop.propertyValueType === PropertyValueType.ThreeD_SPATIAL) ? [0, 0, 0] : [0, 0];
    for (i = 0; i < pp.k.length; i++) {
      k = pp.k[i];
      idx = prop.nearestKeyIndex(k.t);
      if (spatial) {
        // After Effects bends the path through new position keys by default; the plan's motion runs in straight lines.
        try {
          prop.setSpatialAutoBezierAtKey(idx, false);
          prop.setSpatialContinuousAtKey(idx, false);
          prop.setSpatialTangentsAtKey(idx, zero, zero);
          prop.setRovingAtKey(idx, false);
        } catch (e1) {}
      }
      try {
        count = prop.keyInTemporalEase(idx).length;
        prop.setTemporalEaseAtKey(idx, easeObjects(k.ie, count), easeObjects(k.oe, count));
      } catch (e2) {
        st.warnings.push({ message: 'The easing of "' + prop.name + '" could not be set on one key (' + String(e2) + ').' });
      }
      // Setting an ease makes both sides bezier: say afterwards which sides are linear or hold.
      try { prop.setInterpolationTypeAtKey(idx, interpValue(k.ii), interpValue(k.oi)); } catch (e3) {}
    }
    st.keys += pp.k.length;
  }

  function applySettings(group, settings, st) {
    var i, prop;
    if (!group || !settings) return;
    for (i = 0; i < settings.length; i++) {
      try { prop = group.property(settings[i][0]); } catch (e) { prop = null; }
      if (prop) applyProp(prop, settings[i][1], st);
    }
  }

  /**
   * Fills a shape group with the plan's items, first one on top. Adding a
   * property makes After Effects forget the references to its neighbours, so
   * every item is looked up by its position again whenever it is needed.
   */
  function buildShapeItems(group, items, st) {
    var i, j, it, index, shape, dashes, name;
    for (i = 0; i < items.length; i++) {
      it = items[i];
      group.addProperty(it.mn);
      index = group.numProperties;
      try { group.property(index).name = it.name; } catch (e1) {}
      if (it.mn === 'ADBE Vector Group') {
        buildShapeItems(group.property(index).property('ADBE Vectors Group'), it.items || [], st);
        applySettings(group.property(index).property('ADBE Vector Transform Group'), it.tr, st);
        continue;
      }
      if (it.path) {
        shape = new Shape();
        shape.vertices = it.path.v;
        shape.inTangents = it.path.i;
        shape.outTangents = it.path.o;
        shape.closed = !!it.path.closed;
        group.property(index).property('ADBE Vector Shape').setValue(shape);
      }
      applySettings(group.property(index), it.set, st);
      if (it.dashes) {
        for (j = 0; j < it.dashes.length; j++) {
          name = (j % 2 === 0) ? 'ADBE Vector Stroke Dash ' + (j / 2 + 1) : 'ADBE Vector Stroke Gap ' + ((j + 1) / 2);
          try {
            dashes = group.property(index).property('ADBE Vector Stroke Dashes');
            dashes.addProperty(name);
            group.property(index).property('ADBE Vector Stroke Dashes').property(name).setValue(it.dashes[j]);
          } catch (e2) {}
        }
      }
    }
  }

  function squeezed(text) {
    return String(text).split(' ').join('');
  }

  /** The font's PostScript name, which is what After Effects wants to be told. */
  function fontFor(T) {
    var found;
    if (T.font) return T.font;
    try {
      if (app.fonts && app.fonts.getFontsByFamilyNameAndStyleName) {
        found = app.fonts.getFontsByFamilyNameAndStyleName(T.family, T.style);
        if (found && found.length) return found[0].postScriptName;
      }
    } catch (e) {}
    // The way most PostScript names are put together.
    return squeezed(T.family) + '-' + squeezed(T.style || 'Regular');
  }

  function justifyValue(name) {
    var P = ParagraphJustification;
    if (name === 'center') return P.CENTER_JUSTIFY;
    if (name === 'right') return P.RIGHT_JUSTIFY;
    if (name === 'justify') return P.FULL_JUSTIFY_LASTLINE_LEFT;
    return P.LEFT_JUSTIFY;
  }

  /**
   * Styles a text layer and works out where its own origin (the start of the
   * first baseline, or what a text box is measured from) has to lie in the
   * plan's coordinates. Returns that point.
   */
  function buildText(layer, T, st) {
    var prop = layer.property('ADBE Text Properties').property('ADBE Text Document');
    var td = prop.value, wanted = fontFor(T), origin, pos, r, want;
    try { td.resetCharStyle(); } catch (e0) {}
    try { td.resetParagraphStyle(); } catch (e00) {}
    td.font = wanted;
    td.fontSize = T.size;
    td.applyFill = !!T.fill;
    if (T.fill) td.fillColor = T.fill;
    td.applyStroke = !!T.stroke;
    if (T.stroke) {
      td.strokeColor = T.stroke;
      td.strokeWidth = T.strokeWidth;
    }
    td.tracking = T.tracking;
    td.justification = justifyValue(T.justify);
    try { if (T.leading > 0) td.leading = T.leading; } catch (e1) {}
    try {
      if (T.caps === 'all') td.fontCapsOption = FontCapsOption.FONT_ALL_CAPS;
      else if (T.caps === 'small') td.fontCapsOption = FontCapsOption.FONT_SMALL_CAPS;
    } catch (e2) {}
    prop.setValue(td);

    td = prop.value;
    try {
      if (td.font !== wanted) {
        st.warnings.push({ layer: layer.name, message: 'The font "' + T.family + ' ' + T.style + '" is not installed for After Effects; "' + td.font + '" is used instead.' });
      }
    } catch (e3) {}

    if (T.box) {
      // A text box is measured from its own position; put it where the plan has it, or work with where it is.
      try {
        td.boxTextPos = [T.box[0], T.box[1]];
        prop.setValue(td);
        td = prop.value;
      } catch (e4) {}
      try { pos = td.boxTextPos; } catch (e5) { pos = [-T.box[2] / 2, -T.box[3] / 2]; }
      origin = [T.box[0] - pos[0], T.box[1] - pos[1]];
    } else {
      origin = [T.origin[0], T.origin[1]];
    }

    if (T.ink) {
      // Where the glyphs really are, against where they are in Figma: that needs no font metrics.
      try {
        r = layer.sourceRectAtTime(0, false);
        if (r.width > 0 && r.height > 0) {
          origin[1] = T.ink[1] - r.top;
          if (!T.box) {
            if (T.justify === 'center') want = T.ink[0] + T.ink[2] / 2 - (r.left + r.width / 2);
            else if (T.justify === 'right') want = T.ink[0] + T.ink[2] - (r.left + r.width);
            else want = T.ink[0] - r.left;
            origin[0] = want;
          }
        }
      } catch (e6) {}
    }
    return origin;
  }

  function shifted(pp, dx, dy) {
    var out = { v: [pp.v[0] - dx, pp.v[1] - dy] }, i, k;
    if (pp.k) {
      out.k = [];
      for (i = 0; i < pp.k.length; i++) {
        k = pp.k[i];
        out.k.push({ t: k.t, v: [k.v[0] - dx, k.v[1] - dy], ii: k.ii, oi: k.oi, ie: k.ie, oe: k.oe });
      }
    }
    return out;
  }

  function buildShadow(layer, S) {
    var fx = layer.property('ADBE Effect Parade').addProperty('ADBE Drop Shadow'), op, max = 255;
    fx.property('ADBE Drop Shadow-0001').setValue([S.color[0], S.color[1], S.color[2], 1]);
    op = fx.property('ADBE Drop Shadow-0002');
    // Scripts see this opacity on a scale that ends at 255 (or 100, depending on the version).
    try { if (op.hasMax && op.maxValue > 0) max = op.maxValue; } catch (e) {}
    op.setValue(S.opacity * max);
    fx.property('ADBE Drop Shadow-0003').setValue(S.direction);
    fx.property('ADBE Drop Shadow-0004').setValue(S.distance);
    fx.property('ADBE Drop Shadow-0005').setValue(S.softness);
  }

  /** A nested composition's time remapping: the plan's keys instead of the two After Effects starts with. */
  function buildRemap(layer, pp, st) {
    var prop, i, j, keep, t, times = [];
    layer.timeRemapEnabled = true;
    prop = layer.property('ADBE Time Remapping');
    if (pp.k && pp.k.length > 1) {
      for (i = 0; i < pp.k.length; i++) times.push(pp.k[i].t);
      applyProp(prop, pp, st);
    } else {
      times.push(0);
      prop.setValueAtTime(0, pp.v);
    }
    for (i = prop.numKeys; i >= 1; i--) {
      t = prop.keyTime(i);
      keep = false;
      for (j = 0; j < times.length; j++) if (Math.abs(times[j] - t) < 0.0005) keep = true;
      if (!keep && prop.numKeys > 1) prop.removeKey(i);
    }
  }

  function addLayer(comp, L, st) {
    var layer, T;
    if (L.type === 'shape') {
      layer = comp.layers.addShape();
    } else if (L.type === 'text') {
      T = L.text;
      layer = T.box ? comp.layers.addBoxText([Math.max(1, T.box[2]), Math.max(1, T.box[3])], T.text) : comp.layers.addText(T.text);
    } else if (L.type === 'null') {
      layer = comp.layers.addNull(comp.duration);
      try {
        layer.source.width = L.size[0];
        layer.source.height = L.size[1];
      } catch (e1) {}
    } else if (L.type === 'solid') {
      layer = comp.layers.addSolid(L.solid.color, L.name, L.solid.w, L.solid.h, 1, comp.duration);
    } else if (L.type === 'image') {
      layer = comp.layers.add(st.footage[L.image.footage], comp.duration);
    } else if (L.type === 'comp') {
      layer = comp.layers.add(st.comps[L.comp.id]);
    } else {
      return null;
    }
    layer.name = L.name;
    return layer;
  }

  function buildComp(C, st) {
    var comp = app.project.items.addComp(C.name, C.w, C.h, 1, C.duration, C.frameRate);
    var byId = {}, i, j, L, layer, tg, origin, mn, pp, M, matte, type;
    st.made.push(comp);
    comp.bgColor = C.bg;

    // Back to front: every new layer lands on top of the ones before it.
    for (i = C.layers.length - 1; i >= 0; i--) {
      L = C.layers[i];
      try {
        layer = addLayer(comp, L, st);
      } catch (e1) {
        layer = null;
        st.warnings.push({ comp: C.name, layer: L.name, message: 'This layer could not be made: ' + String(e1) });
      }
      if (layer) {
        byId[L.id] = layer;
        st.layers++;
      }
    }
    // Parents first, so the transforms that follow are counted in the parent's space.
    for (i = 0; i < C.layers.length; i++) {
      L = C.layers[i];
      layer = byId[L.id];
      if (!layer || L.parent === undefined || !byId[L.parent]) continue;
      try { layer.setParentWithJump(byId[L.parent]); } catch (e2) {
        try { layer.parent = byId[L.parent]; } catch (e3) {}
      }
    }
    for (i = 0; i < C.layers.length; i++) {
      L = C.layers[i];
      layer = byId[L.id];
      if (!layer) continue;
      try {
        origin = null;
        if (L.type === 'shape') buildShapeItems(layer.property('ADBE Root Vectors Group'), L.shape || [], st);
        else if (L.type === 'text') origin = buildText(layer, L.text, st);
        else if (L.type === 'comp') {
          layer.startTime = L.comp.start;
          if (L.comp.remap) buildRemap(layer, L.comp.remap, st);
        }

        tg = layer.property('ADBE Transform Group');
        if (L.sep) tg.property('ADBE Position').dimensionsSeparated = true;
        for (j = 0; j < L.tr.length; j++) {
          mn = L.tr[j][0];
          pp = L.tr[j][1];
          // A text layer's own origin is the baseline (or the box); the plan counts from the content's corner.
          if (origin && mn === 'ADBE Anchor Point') pp = shifted(pp, origin[0], origin[1]);
          applyProp(tg.property(mn), pp, st);
        }

        if (L.blend) layer.blendingMode = blendValue(L.blend);
        if (L.shadow) buildShadow(layer, L.shadow);
        if (L.span) {
          layer.inPoint = L.span[0];
          layer.outPoint = L.span[1];
        }
      } catch (e4) {
        st.warnings.push({ comp: C.name, layer: L.name, message: 'This layer could not be finished: ' + String(e4) + (e4 && e4.line ? ' (line ' + e4.line + ')' : '') });
      }
    }
    // Mattes last: every layer is there and in its place.
    for (i = 0; i < C.layers.length; i++) {
      L = C.layers[i];
      layer = byId[L.id];
      if (!layer) continue;
      M = L.matte;
      matte = M ? byId[M.id] : null;
      if (M && matte) {
        type = M.luma ? (M.inverted ? TrackMatteType.LUMA_INVERTED : TrackMatteType.LUMA) : (M.inverted ? TrackMatteType.ALPHA_INVERTED : TrackMatteType.ALPHA);
        try {
          if (typeof layer.setTrackMatte === 'function') layer.setTrackMatte(matte, type);
          else if (matte.index === layer.index - 1) layer.trackMatteType = type;
          else st.warnings.push({ comp: C.name, layer: L.name, message: 'This After Effects version only takes the layer directly above as a track matte; the layer arrives unmasked.' });
        } catch (e5) {
          st.warnings.push({ comp: C.name, layer: L.name, message: 'The track matte could not be set: ' + String(e5) });
        }
      }
    }
    for (i = 0; i < C.layers.length; i++) {
      L = C.layers[i];
      if (L.off && byId[L.id]) {
        try { byId[L.id].enabled = false; } catch (e6) {}
      }
    }
    return comp;
  }

  /** The footage item of a file: the one the project already has, or a new import. */
  function footageFor(F, st) {
    var file = new File(F.file), i, item, io, src;
    if (!file.exists) throw new Error('The image "' + F.name + '" is not on disk.');
    for (i = 1; i <= app.project.numItems; i++) {
      item = app.project.item(i);
      if (!(item instanceof FootageItem)) continue;
      try {
        src = item.mainSource;
        if (src instanceof FileSource && src.file && src.file.fsName === file.fsName) return item;
      } catch (e) {}
    }
    io = new ImportOptions(file);
    try { io.sequence = false; } catch (e1) {}
    try { if (io.canImportAs(ImportAsType.FOOTAGE)) io.importAs = ImportAsType.FOOTAGE; } catch (e2) {}
    item = app.project.importFile(io);
    st.made.push(item);
    st.fresh.push(item);
    try { item.name = F.name; } catch (e3) {}
    return item;
  }

  /** The settings a new composition gets when the frame has none of its own: those of the open composition, else what most of the project uses. */
  api.buildDefaults = function () {
    try {
      var item = app.project ? app.project.activeItem : null, rates = {}, lengths = {}, i, it, key, best = 0, rate = 30, length = 5, bestLength = 0;
      if (item && item instanceof CompItem) return stringify({ ok: true, frameRate: num(item.frameRate), duration: num(item.duration) });
      if (app.project) {
        for (i = 1; i <= app.project.numItems; i++) {
          it = app.project.item(i);
          if (!(it instanceof CompItem)) continue;
          key = String(num(it.frameRate));
          rates[key] = (rates[key] || 0) + 1;
          if (rates[key] > best) {
            best = rates[key];
            rate = num(it.frameRate);
          }
          key = String(num(it.duration));
          lengths[key] = (lengths[key] || 0) + 1;
          if (lengths[key] > bestLength) {
            bestLength = lengths[key];
            length = num(it.duration);
          }
        }
      }
      return stringify({ ok: true, frameRate: rate, duration: length });
    } catch (e) {
      return fail('EXCEPTION', String(e), e);
    }
  };

  /** Where the images of a transfer are kept: next to the project file, or in Documents while the project has no file yet. */
  api.footageFolder = function () {
    try {
      var base = (app.project && app.project.file) ? app.project.file.parent : Folder.myDocuments;
      return stringify({ ok: true, path: base.fsName + '/Motion Bridge Footage' });
    } catch (e) {
      return fail('EXCEPTION', String(e), e);
    }
  };

  /**
   * Builds the compositions of one plan (a file written by the panel). All of
   * it is one undo step; if it fails half way, that step is taken back, so
   * the project is left as it was.
   */
  api.buildFromFile = function (path, open) {
    var st = { comps: {}, footage: {}, made: [], fresh: [], warnings: [], layers: 0, keys: 0 };
    var opened = false, plan, folder = null, i, root = null, comp, item;
    try {
      if (!app.project) return fail('NO_PROJECT', 'After Effects has no project open.');
      plan = readPlan(path);
      app.beginUndoGroup('Motion Bridge: build "' + plan.name + '"');
      opened = true;

      for (i = 0; i < plan.footage.length; i++) st.footage[plan.footage[i].id] = footageFor(plan.footage[i], st);
      for (i = 0; i < plan.comps.length; i++) {
        comp = buildComp(plan.comps[i], st);
        st.comps[plan.comps[i].id] = comp;
        if (plan.comps[i].id === plan.root) root = comp;
      }
      // Everything but the composition itself goes into a folder of its own.
      if (st.fresh.length || plan.comps.length > 1) {
        folder = app.project.items.addFolder(plan.folder);
        st.made.push(folder);
        for (i = 0; i < st.fresh.length; i++) st.fresh[i].parentFolder = folder;
        for (i = 0; i < plan.comps.length; i++) {
          item = st.comps[plan.comps[i].id];
          if (item !== root) item.parentFolder = folder;
        }
      }
      app.endUndoGroup();
      opened = false;
      if (root && open) {
        try { root.openInViewer(); } catch (e1) {}
      }
      return stringify({
        ok: true,
        data: {
          id: root ? String(root.id) : null,
          name: root ? root.name : plan.name,
          comps: plan.comps.length,
          layers: st.layers,
          keys: st.keys,
          images: plan.footage.length,
          warnings: st.warnings
        }
      });
    } catch (e) {
      if (opened) {
        try { app.endUndoGroup(); } catch (e2) {}
        // Only when this script has put something into the project is its step the one on top.
        if (st.made.length) {
          try { app.executeCommand(16); } catch (e3) {}
        }
      }
      return fail('EXCEPTION', String(e), e);
    }
  };

  return api;
})();
