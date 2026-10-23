'use strict';

// ── Constants ────────────────────────────────────────────────────────────────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Classed symbols, no continuous ramps. Size repeats the color class so the
// dots read on a dark ground at any zoom. Sequential values -- trips, typical
// miss -- use Brewer YlGnBu over five quantile classes of the values in view.
// Vs. expected is diverging about 1x: Brewer RdBu with fixed breaks symmetric
// in log space, reversed so over-connected is warm, and dots that grow with
// distance from expected in either direction.
const SEQ_COLORS   = d3.schemeYlGnBu[5];
const DIV_COLORS   = [...d3.schemeRdBu[5]].reverse();
const RATIO_BREAKS = [0.5, 0.8, 1.25, 2];
const SEQ_SIZES    = [1.6, 2.2, 2.9, 3.7, 4.6];   // map radius per class, px at citywide zoom
const DIV_SIZES    = [4.6, 3.3, 2.2, 3.3, 4.6];
// The selection is a dark dot in a white ring, not a white dot: RdBu's middle
// class ("about as expected") is near-white, and the two were indistinguishable.
const SELECTED_R    = 5.5;
const SELECTED_FILL = '#141414';
const SELECTED_RING = '#ffffff';
const CONTEXT_R    = 1.1;
const CONTEXT_FILL = '#4a4a4a';
const EDGE_TRIPS   = '#a0a0a0';
const EDGE_OVER    = '#f0a04b';
const EDGE_UNDER   = '#5b8fc9';

// Map zoom. Dots grow a little as you zoom in (screen radius x k^0.45), so they
// stay legible citywide without turning into blobs at street level.
const ZOOM_GROWTH = 0.45;
const MAX_AUTO_K  = 14;   // auto-zoom stops here even when every partner is a block away
const FIT_SHARE   = 0.9;  // auto-zoom fits the partners carrying this share of the shown trips
const NET_LABELS  = 8;    // partners labelled in the network, busiest first

const state = { sel: null, k: 20, metric: 'trips' };
let S = [];      // stations, from data/station_network.json
let META = null;

const useResidual = () => state.metric === 'residual';
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

// ── Data ─────────────────────────────────────────────────────────────────────
Promise.all([
  d3.json('data/station_network.json'),
  d3.json('data/boroughs.geojson'),
]).then(([net, boroughs]) => {
  META = net.meta;
  S = net.stations;
  S.forEach((s, i) => { s.i = i; s.total = s.out + s.in; });
  document.getElementById('loading').style.display = 'none';
  initMap(boroughs);
  initNetwork();
  initControls();
  render();
}).catch(err => {
  console.error(err);
  const el = document.getElementById('loading');
  el.textContent = 'Could not load the station data. Try reloading the page.';
  el.style.display = 'flex';
});

// Partners of station i, busiest first, cut to the slider. p rows are
// [partner, trips from i, trips to i, expected trips both ways].
function partners(i) {
  return S[i].p.slice(0, state.k).map(([j, ab, ba, exp]) =>
    ({ j, ab, ba, exp, trips: ab + ba, ratio: (ab + ba) / exp }));
}

// How far off the model typically is for a station's trips: the trip-weighted
// mean |log(actual / expected)| over its partners on show, as a factor. Each
// station's expected total equals its actual total by construction, so "does
// it beat its geography overall" has no answer; this is the overview that does.
function typicalMiss(i) {
  let w = 0, s = 0;
  for (const p of partners(i)) { s += p.trips * Math.abs(Math.log(p.ratio)); w += p.trips; }
  return w ? Math.exp(s / w) : null;
}

// Trips between the selection and station j, from whichever top-50 list has the pair.
function pairInfo(sel, j) {
  const r = S[sel].p.findIndex(x => x[0] === j);
  if (r >= 0) {
    const [, ab, ba, exp] = S[sel].p[r];
    return { fromSel: ab, toSel: ba, exp, rank: r + 1 };
  }
  const q = S[j].p.find(x => x[0] === sel);
  return q ? { fromSel: q[2], toSel: q[1], exp: q[3], rank: null } : null;
}

function monthRanges(active) {
  const runs = [];
  for (const m of active) {
    const last = runs[runs.length - 1];
    if (last && m === last[1] + 1) last[1] = m; else runs.push([m, m]);
  }
  return runs.map(([a, b]) => a === b ? MONTHS[a] : `${MONTHS[a]}–${MONTHS[b]}`).join(', ');
}

// ── Classes ──────────────────────────────────────────────────────────────────
const fmtCount = v => Math.round(v).toLocaleString();
const fmtRatio = v => (v >= 10 ? v.toFixed(1) : v.toFixed(2)) + '×';

// Labels give the range of values actually in view, not the class bounds.
function classRows(values, scale, colors, sizes, fmt, keepEmpty) {
  return colors.map((color, c) => {
    const inClass = values.filter(v => scale(v) === color);
    if (!inClass.length) return keepEmpty ? { color, r: sizes[c], label: 'none in view' } : null;
    const [lo, hi] = d3.extent(inClass);
    return { color, r: sizes[c], label: fmt(lo) === fmt(hi) ? fmt(lo) : `${fmt(lo)} – ${fmt(hi)}` };
  }).filter(Boolean);
}

const NO_CLASSES = { color: () => CONTEXT_FILL, size: () => CONTEXT_R, rows: [], note: null };

function quantileClasses(values, fmt) {
  if (!values.length) return NO_CLASSES;
  const scale = d3.scaleQuantile().domain(values).range(SEQ_COLORS);
  return {
    color: scale,
    size: v => SEQ_SIZES[SEQ_COLORS.indexOf(scale(v))],
    rows: classRows(values, scale, SEQ_COLORS, SEQ_SIZES, fmt, false),
    note: 'Ranges adjust to current view',
  };
}

function ratioClasses(values) {
  if (!values.length) return NO_CLASSES;
  const scale = d3.scaleThreshold().domain(RATIO_BREAKS).range(DIV_COLORS);
  return {
    color: scale,
    size: v => DIV_SIZES[DIV_COLORS.indexOf(scale(v))],
    rows: classRows(values, scale, DIV_COLORS, DIV_SIZES, fmtRatio, true),
    note: 'Breaks at 0.5, 0.8, 1.25 and 2×',
  };
}

// One value per station in view. With nothing selected: every station's total
// trips, or its typical miss. With a station selected: each partner's trips
// with it, or their ratio to expected.
function buildView() {
  const value = new Map();
  let ps = null;
  if (state.sel === null) {
    for (const s of S) {
      const v = useResidual() ? typicalMiss(s.i) : s.total;
      if (v) value.set(s.i, v);
    }
  } else {
    ps = partners(state.sel);
    for (const p of ps) value.set(p.j, useResidual() ? p.ratio : p.trips);
  }
  const values = [...value.values()];
  const classes = useResidual() && state.sel !== null ? ratioClasses(values)
    : quantileClasses(values, useResidual() ? fmtRatio : fmtCount);
  return { value, partners: ps, classes };
}

function render() {
  const view = buildView();
  drawMap(view);
  drawNetwork(view);
  updateLegends(view);
  updateSidebar(view);
}

function select(i) {
  if (i === state.sel) return;
  state.sel = i;
  render();
  zoomToSelection(750);
}

// ── Map ──────────────────────────────────────────────────────────────────────
const mapContainer = document.getElementById('map-container');
const mapSvg  = d3.select('#map');
const mapG    = mapSvg.append('g');
const landG   = mapG.append('g');
const flowG   = mapG.append('g').attr('pointer-events', 'none');
const dotG    = mapG.append('g');
let projection, geoPath, mapK = 1;

const mapZoom = d3.zoom().scaleExtent([1, 40]).on('zoom', e => {
  mapK = e.transform.k;
  mapG.attr('transform', e.transform);
  restyleMapForZoom();
});
mapSvg.call(mapZoom).on('dblclick.zoom', null);
mapSvg.on('click', () => select(null));

function mapSize() {
  const r = mapContainer.getBoundingClientRect();
  return { w: r.width || 700, h: r.height || 700 };
}

function initMap(boroughs) {
  projection = d3.geoMercator();
  geoPath = d3.geoPath(projection);
  landG.selectAll('path').data(boroughs.features).enter().append('path')
    .attr('fill', '#222').attr('stroke', '#383838');
  dotG.selectAll('circle').data(S).enter().append('circle')
    .attr('cursor', 'pointer')
    .on('mouseover', (e, d) => showTooltip(e, d.i))
    .on('mousemove', moveTooltip)
    .on('mouseout', hideTooltip)
    .on('click', (e, d) => {
      e.stopPropagation();
      select(state.sel === d.i ? null : d.i);
      showTooltip(e, d.i);   // its content depends on the selection
    });
  placeMap();
}

// Fit the service area rather than the five boroughs: most of Staten Island
// and eastern Queens have no stations.
function placeMap() {
  const { w, h } = mapSize();
  projection.fitExtent([[24, 24], [w - 24, h - 24]],
    { type: 'MultiPoint', coordinates: S.map(s => [s.lon, s.lat]) });
  landG.selectAll('path').attr('d', geoPath);
  for (const s of S) [s.mx, s.my] = projection([s.lon, s.lat]);
  dotG.selectAll('circle').attr('cx', d => d.mx).attr('cy', d => d.my);
  flowG.selectAll('line')
    .attr('x1', l => l.a.mx).attr('y1', l => l.a.my)
    .attr('x2', l => l.b.mx).attr('y2', l => l.b.my);
}

function restyleMapForZoom() {
  const f = Math.pow(mapK, ZOOM_GROWTH) / mapK;   // screen px -> map units
  dotG.selectAll('circle')
    .attr('r', d => d._r * f)
    .attr('stroke-width', d => d._sw / mapK);
  flowG.selectAll('line').attr('stroke-width', 1 / mapK);
  landG.selectAll('path').attr('stroke-width', 0.8 / mapK);
}

function drawMap(view) {
  const sel = state.sel, c = view.classes;
  const dots = dotG.selectAll('circle');
  dots.each(d => {
    if (d.i === sel) {
      Object.assign(d, { _fill: SELECTED_FILL, _stroke: SELECTED_RING, _r: SELECTED_R, _sw: 2.5, _key: 1e6 });
    } else if (view.value.has(d.i)) {
      const v = view.value.get(d.i);
      Object.assign(d, { _fill: c.color(v), _stroke: '#141414', _r: c.size(v), _sw: 0.5, _key: 100 - c.size(v) });
    } else {
      Object.assign(d, { _fill: CONTEXT_FILL, _stroke: 'none', _r: CONTEXT_R, _sw: 0, _key: -1 });
    }
  });
  // Context underneath, then the largest classes, small dots on top of big
  // ones, the selection last of all.
  dots.attr('fill', d => d._fill).attr('stroke', d => d._stroke).sort((a, b) => a._key - b._key);

  const flows = view.partners ? view.partners.map(p => ({
    a: S[sel], b: S[p.j],
    color: !useResidual() ? EDGE_TRIPS : p.ratio >= 1 ? EDGE_OVER : EDGE_UNDER,
  })) : [];
  flowG.selectAll('line').data(flows).join('line')
    .attr('x1', l => l.a.mx).attr('y1', l => l.a.my)
    .attr('x2', l => l.b.mx).attr('y2', l => l.b.my)
    .attr('stroke', l => l.color)
    .attr('stroke-opacity', 0.45);
  restyleMapForZoom();
}

// Zoom to the selection and the partners carrying most of its shown trips, so
// one far-off partner cannot stretch the view. Nothing selected: the whole city.
function zoomToSelection(ms) {
  const t = mapSvg.transition().duration(ms);
  if (state.sel === null) { t.call(mapZoom.transform, d3.zoomIdentity); return; }
  const { w, h } = mapSize();
  const ps = partners(state.sel);
  const total = d3.sum(ps, p => p.trips);
  const fit = [state.sel];
  let cum = 0;
  for (const p of ps) {
    if (cum >= FIT_SHARE * total) break;
    fit.push(p.j);
    cum += p.trips;
  }
  const [x0, x1] = d3.extent(fit, i => S[i].mx);
  const [y0, y1] = d3.extent(fit, i => S[i].my);
  const k = Math.max(1, Math.min(MAX_AUTO_K,
    0.8 / Math.max((x1 - x0) / w, (y1 - y0) / h, 1e-9)));
  t.call(mapZoom.transform, d3.zoomIdentity
    .translate(w / 2, h / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2));
}

// ── Network ──────────────────────────────────────────────────────────────────
// Only the selected station and its partners on show. Spokes run from the
// selection to each partner; partner-to-partner links come from the partners'
// own top-50 lists, which is what lets the layout show clusters among them.
const netContainer = document.getElementById('chart-container');
const netSvg    = d3.select('#chart');
const netG      = netSvg.append('g');
const netLinkG  = netG.append('g');
const netNodeG  = netG.append('g');
const netLabelG = netG.append('g').attr('pointer-events', 'none');
const netPos    = new Map();   // station -> last position, so walking the network stays smooth
let sim, netNodes = [];

netSvg.call(d3.zoom().scaleExtent([0.3, 6]).on('zoom', e => netG.attr('transform', e.transform)));
netSvg.on('click', () => select(null));

function netSize() {
  const r = netContainer.getBoundingClientRect();
  return { w: r.width || 700, h: r.height || 700 };
}

function initNetwork() {
  const { w, h } = netSize();
  sim = d3.forceSimulation()
    .alphaDecay(0.03)
    .force('link', d3.forceLink().id(d => d.i))
    .force('charge', d3.forceManyBody().strength(-170))
    .force('collide', d3.forceCollide(d => d.r + 3))
    .force('x', d3.forceX(w / 2).strength(0.04))
    .force('y', d3.forceY(h / 2).strength(0.04))
    .on('tick', netTick)
    .stop();
}

function drawNetwork(view) {
  const sel = state.sel;
  document.getElementById('net-prompt').style.display = sel === null ? 'flex' : 'none';
  if (sel === null) {
    sim.stop();
    netNodes = [];
    for (const g of [netLinkG, netNodeG, netLabelG]) g.selectAll('*').remove();
    return;
  }
  const { w, h } = netSize();
  const ps = view.partners;
  const inSet = new Set([sel, ...ps.map(p => p.j)]);
  const rScale = d3.scaleSqrt().domain([0, d3.max([...inSet], i => S[i].total)]).range([3, 16]);

  netNodes = [...inSet].map(i => {
    const prev = netPos.get(i);
    return {
      i, r: i === sel ? Math.max(9, rScale(S[i].total)) : rScale(S[i].total),
      x: prev ? prev.x : w / 2 + (Math.random() - 0.5) * 240,
      y: prev ? prev.y : h / 2 + (Math.random() - 0.5) * 240,
      fx: i === sel ? w / 2 : null, fy: i === sel ? h / 2 : null,
    };
  });

  const links = ps.map(p => ({ source: sel, target: p.j, trips: p.trips, ratio: p.ratio, spoke: true }));
  const seen = new Set();
  for (const a of inSet) {
    if (a === sel) continue;
    for (const [j, ab, ba, exp] of S[a].p) {
      if (j === sel || !inSet.has(j)) continue;
      const key = Math.min(a, j) * 1e5 + Math.max(a, j);
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: a, target: j, trips: ab + ba, ratio: (ab + ba) / exp, spoke: false });
    }
  }

  // Under trips, weight is log trips across the links on show. Under vs.
  // expected only over-connected pairs pull, as in the district-level tool;
  // ink shows distance from expected either way.
  const [tmin, tmax] = d3.extent(links, l => Math.log(l.trips));
  const posMax = d3.max(links, l => Math.max(0, Math.log(l.ratio))) || 1;
  const absMax = d3.max(links, l => Math.abs(Math.log(l.ratio))) || 1;
  for (const l of links) {
    l.w = useResidual() ? Math.max(0, Math.log(l.ratio)) / posMax
      : tmax > tmin ? (Math.log(l.trips) - tmin) / (tmax - tmin) : 1;
    l.ink = useResidual() ? Math.abs(Math.log(l.ratio)) / absMax : l.w;
  }
  const deg = new Map();
  for (const l of links) for (const e of [l.source, l.target]) deg.set(e, (deg.get(e) || 0) + 1);

  sim.nodes(netNodes);
  sim.force('link').links(links)
    .distance(l => 150 - 105 * l.w)
    .strength(l => (0.05 + 0.95 * l.w) /
      Math.max(1, Math.min(deg.get(l.source.i), deg.get(l.target.i))));
  sim.force('x').x(w / 2);
  sim.force('y').y(h / 2);

  netLinkG.selectAll('line').data(links).join('line')
    .attr('stroke', l => !useResidual() ? EDGE_TRIPS : l.ratio >= 1 ? EDGE_OVER : EDGE_UNDER)
    .attr('stroke-width', l => 0.4 + 3.6 * Math.pow(l.ink, 1.5))
    .attr('stroke-opacity', l => (l.spoke ? 0.8 : 0.3) * (0.25 + 0.75 * l.ink));

  netNodeG.selectAll('circle').data(netNodes, d => d.i).join('circle')
    .attr('r', d => d.r)
    .attr('fill', d => d.i === sel ? SELECTED_FILL : view.classes.color(view.value.get(d.i)))
    .attr('stroke', d => d.i === sel ? SELECTED_RING : '#141414')
    .attr('stroke-width', d => d.i === sel ? 3 : 1)
    .attr('cursor', 'pointer')
    .on('mouseover', (e, d) => showTooltip(e, d.i))
    .on('mousemove', moveTooltip)
    .on('mouseout', hideTooltip)
    .on('click', (e, d) => {
      e.stopPropagation();
      if (d.i !== sel) { select(d.i); showTooltip(e, d.i); }
    })
    .call(d3.drag()
      .on('start', (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag',  (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end',   (e, d) => {
        if (!e.active) sim.alphaTarget(0);
        if (d.i !== state.sel) { d.fx = null; d.fy = null; }
      }));

  const top = new Set(ps.slice(0, NET_LABELS).map(p => p.j));
  netLabelG.selectAll('text')
    .data(netNodes.filter(d => d.i === sel || top.has(d.i)), d => d.i)
    .join('text')
    .attr('text-anchor', 'middle')
    .attr('font-size', d => d.i === sel ? '11px' : '9.5px')
    .attr('font-weight', d => d.i === sel ? 700 : 600)
    .attr('fill', '#ddd')
    .attr('paint-order', 'stroke')
    .attr('stroke', '#141414')
    .attr('stroke-width', 3)
    .attr('stroke-linejoin', 'round')
    .text(d => S[d.i].name);

  sim.alpha(0.9).restart();
}

function netTick() {
  netLinkG.selectAll('line')
    .attr('x1', l => l.source.x).attr('y1', l => l.source.y)
    .attr('x2', l => l.target.x).attr('y2', l => l.target.y);
  netNodeG.selectAll('circle').attr('cx', d => d.x).attr('cy', d => d.y);
  netLabelG.selectAll('text').attr('x', d => d.x).attr('y', d => d.y + d.r + 11);
  for (const d of netNodes) netPos.set(d.i, { x: d.x, y: d.y });
}

// ── Legends ──────────────────────────────────────────────────────────────────
const mapLegend = d3.select('#map-container').append('div').attr('class', 'panel-legend');
const netLegend = d3.select('#chart-container').append('div').attr('class', 'panel-legend');

// Map swatches are drawn at 1.4x the citywide dot size so the smallest class
// is still visible in the key; the steps between classes are what matter.
function renderLegend(el, sections) {
  el.html('');
  for (const s of sections) {
    const sec = el.append('div').attr('class', 'lg-section');
    if (s.title) sec.append('div').attr('class', 'lg-title').text(s.title);
    if (s.note)  sec.append('div').attr('class', 'lg-note').text(s.note);
    for (const r of s.rows) {
      const row = sec.append('div').attr('class', 'lg-row');
      const sw = row.append('span').attr('class', 'lg-box').append('span');
      if (r.line) {
        sw.attr('class', 'lg-sw line').style('background', r.color);
      } else {
        const d = Math.round(2 * r.r * 1.4 + 1);
        sw.attr('class', 'lg-sw').style('width', `${d}px`).style('height', `${d}px`)
          .style('background', r.color)
          .style('border', r.ring ? `2px solid ${r.ring}` : null);
      }
      row.append('span').text(r.label);
    }
  }
}

function legendTitle() {
  if (state.sel === null) {
    return useResidual() ? `Typical miss vs. expected, top ${state.k} partners`
                         : 'Trips per station';
  }
  const name = S[state.sel].name;
  return useResidual() ? `Vs. expected: trips with ${name}` : `Trips with ${name}`;
}

function updateLegends(view) {
  const title = legendTitle(), c = view.classes;
  const selected = state.sel === null ? [] : [
    { color: SELECTED_FILL, r: SELECTED_R / 1.4, ring: SELECTED_RING, label: 'Selected station' },
    { color: CONTEXT_FILL, r: CONTEXT_R, label: 'Other stations' },
  ];
  renderLegend(mapLegend, [
    { title, note: c.note, rows: c.rows },
    ...(selected.length ? [{ rows: selected }] : []),
  ]);

  if (state.sel === null) { renderLegend(netLegend, []); return; }
  const sections = [
    { title, note: 'Circle size: station’s total trips',
      rows: c.rows.map(r => ({ ...r, r: 4 })).concat(
        [{ color: SELECTED_FILL, r: 4, ring: SELECTED_RING, label: 'Selected station' }]) },
  ];
  sections.push(useResidual()
    ? { title: 'Edges', note: 'Thicker = further from expected', rows: [
        { line: true, color: EDGE_OVER,  label: 'More trips than expected' },
        { line: true, color: EDGE_UNDER, label: 'Fewer trips than expected' }] }
    : { title: 'Edges', note: 'Thicker = more trips', rows: [] });
  renderLegend(netLegend, sections);
}

// ── Sidebar ──────────────────────────────────────────────────────────────────
function initControls() {
  // Search: names are mostly unique; the few repeats get their ID appended.
  const counts = d3.rollup(S, v => v.length, s => s.name);
  const labelOf = s => counts.get(s.name) > 1 ? `${s.name} (${s.id})` : s.name;
  const byLabel = new Map(S.map(s => [labelOf(s), s.i]));
  d3.select('#station-list').selectAll('option')
    .data([...byLabel.keys()].sort()).join('option').attr('value', d => d);
  const search = document.getElementById('search');
  search.addEventListener('change', () => {
    const i = byLabel.get(search.value);
    if (i !== undefined) { select(i); search.blur(); }
  });

  document.getElementById('k-slider').addEventListener('input', e => {
    state.k = +e.target.value;
    document.getElementById('k-val').textContent = state.k;
    render();
    if (state.sel !== null) zoomToSelection(400);
  });
  document.querySelectorAll('input[name="metric"]').forEach(el =>
    el.addEventListener('change', () => { state.metric = el.value; render(); }));

  document.getElementById('stat-stations').textContent = S.length.toLocaleString();
  document.getElementById('stat-trips').textContent = `${(META.trips / 1e6).toFixed(1)}M`;
  document.getElementById('stat-fit').textContent = META.deviance_explained.toFixed(3);

  // Starting points for an empty network panel: the busiest station, plus two
  // whose partners make the point of "vs. expected" quickly, if present.
  const busiest = d3.greatest(S, s => s.total);
  const picks = [busiest, ...['Roosevelt Island Tramway', 'Central Park S & 6 Ave']
    .map(n => S.find(s => s.name === n)).filter(Boolean)];
  const text = d3.select('#net-prompt-text');
  text.append('p').text('Select a station on the map, or search for one, to see its network here. Or start with:');
  const ul = text.append('ul');
  for (const s of picks) {
    ul.append('li').append('a').text(s.name + (s === busiest ? ' (busiest)' : ''))
      .on('click', () => select(s.i));
  }
}

function updateSidebar(view) {
  const box = d3.select('#sel-info');
  if (state.sel === null) { box.style('display', 'none').html(''); return; }
  const s = S[state.sel];
  const shown = d3.sum(view.partners, p => p.trips);
  box.style('display', 'block').html(
    `<strong>${esc(s.name)}</strong>` +
    (s.ids.length > 1 ? `IDs ${s.ids.join(', ')} (renumbered in 2025)<br>` : `ID ${s.id}<br>`) +
    (s.active.length < 12 ? `Active ${monthRanges(s.active)}<br>` : '') +
    `${s.total.toLocaleString()} trips to and from other stations<br>` +
    `Top ${view.partners.length} partners carry ${(100 * shown / s.total).toFixed(0)}% of them`);
  box.append('button').text('Clear selection').on('click', () => select(null));
}

// ── Tooltip ──────────────────────────────────────────────────────────────────
const tooltip = d3.select('#tooltip');

function showTooltip(event, i) {
  const s = S[i];
  let html = `<strong>${esc(s.name)}</strong><br><span class="tt-sub">` +
    (s.ids.length > 1 ? `IDs ${s.ids.join(', ')}` : `ID ${s.id}`) +
    (s.active.length < 12 ? ` · active ${monthRanges(s.active)}` : '') + '</span><br>';
  html += state.sel !== null && i !== state.sel ? pairTooltip(state.sel, i) : totalsTooltip(i);
  tooltip.style('display', 'block').html(html);
  moveTooltip(event);
}

function totalsTooltip(i) {
  const s = S[i];
  let html = `Trips from here: ${s.out.toLocaleString()}<br>` +
    `Trips to here: ${s.in.toLocaleString()}`;
  if (useResidual()) {
    const m = typicalMiss(i);
    if (m) html += `<br>Typical miss vs. expected: ${fmtRatio(m)}`;
  }
  return html;
}

// Directions are named from the selected station, matching the map.
function pairTooltip(sel, j) {
  let html = `<span class="tt-sub">Trips with ${esc(S[sel].name)}</span><br>`;
  const p = pairInfo(sel, j);
  if (!p) return html + 'Not among either station’s top 50 partners';
  html += `From the selected station: ${p.fromSel.toLocaleString()}<br>` +
          `To it: ${p.toSel.toLocaleString()}<br>` +
          `Total: ${(p.fromSel + p.toSel).toLocaleString()}`;
  if (useResidual()) {
    html += `<br>Expected: ${p.exp >= 10 ? Math.round(p.exp).toLocaleString() : p.exp.toFixed(1)} ` +
            `(${fmtRatio((p.fromSel + p.toSel) / p.exp)})`;
  }
  if (p.rank === null) html += '<br><span class="tt-sub">Outside its top 50 partners</span>';
  else if (p.rank > state.k) html += `<br><span class="tt-sub">Its #${p.rank} partner, beyond the ${state.k} shown</span>`;
  return html;
}

function moveTooltip(event) {
  tooltip.style('left', (event.pageX + 14) + 'px').style('top', (event.pageY - 32) + 'px');
}
function hideTooltip() { tooltip.style('display', 'none'); }

// ── Resize ───────────────────────────────────────────────────────────────────
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!S.length) return;
    placeMap();
    zoomToSelection(0);
    if (state.sel !== null) render();
  }, 150);
});
