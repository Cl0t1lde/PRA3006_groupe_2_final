const endpoint = "https://sparql.wikipathways.org/sparql";
const aliasMap = {};

const svg = d3.select("#graph");
const width = svg.node().clientWidth;
const height = svg.node().clientHeight;
const statusEl = document.getElementById("status");
const loadBtn = document.getElementById("loadBtn");
const pathwaySelect = document.getElementById("pathwaySelect");
const pathwayLabel = document.getElementById("pathwayLabel");

// =====================================================
//  DEDUPLICATION (from lionel.js)
// =====================================================
function removeDuplicateInteractions3(rows) {
  const seenEdges = new Set();       // deduplicate by source/target URI
  const canonicalLabel = new Map();  // URI -> chosen label
  const result = [];

  rows.forEach(inter => {
    let src = inter?.source?.value;
    let tgt = inter?.target?.value;
    let srcLabel = inter?.sourceLabel?.value;
    let tgtLabel = inter?.targetLabel?.value;

    if (!src || !tgt) return;

    // canonicalize source
    if (!canonicalLabel.has(src)) {
      canonicalLabel.set(src, srcLabel);
    }
    srcLabel = canonicalLabel.get(src);

    // canonicalize target
    if (!canonicalLabel.has(tgt)) {
      canonicalLabel.set(tgt, tgtLabel);
    }
    tgtLabel = canonicalLabel.get(tgt);

    // deduplicate edge
    const edgeKey = src + "||" + tgt;
    if (seenEdges.has(edgeKey)) {
      console.log("skip duplicate:", edgeKey);
      return;
    }

    seenEdges.add(edgeKey);
    result.push({
      ...inter,
      sourceLabel: { value: srcLabel },
      targetLabel: { value: tgtLabel }
    });

    console.log("keep:", edgeKey);
  });

  return result;
}

// =====================================================
//  LABEL NORMALIZATION (from original chat.js)
// =====================================================
function normalizeLabel(label, nodeMap) {
  const clean = label.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const core0 = clean.split("/")[0];
  const core = aliasMap[core0] || core0;
  let key = core;
  for (const [k] of nodeMap) {
    const min = Math.min(k.length, core.length);
    if (min >= 3 && (k.startsWith(core) || core.startsWith(k))) {
      key = k;
      break;
    }
  }
  const existing = nodeMap.get(key);
  if (!existing) return { key, label };
  const cleanExisting = existing.label.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const extraCur = cleanExisting.startsWith(core) ? cleanExisting.slice(core.length) : "";
  const extraNew = clean.startsWith(core) ? clean.slice(core.length) : "";
  const curNum = /^[0-9]+$/.test(extraCur);
  const newNum = /^[0-9]+$/.test(extraNew);
  let better = existing.label;
  if (!extraCur && newNum) better = existing.label;
  else if (!extraNew && curNum) better = label;
  else better = label.length > existing.label.length ? label : existing.label;
  return { key, label: better };
}

// =====================================================
//  SPARQL QUERY (from lionel.js)
// =====================================================
const getQuery = (pathwayID) => `
PREFIX wp: <http://vocabularies.wikipathways.org/wp#>
PREFIX dcterms: <http://purl.org/dc/terms/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT DISTINCT 
    ?source ?sourceLabel 
    ?target ?targetLabel 
    ?interaction 
    ?interactionType 
    ?sourceType 
    ?targetType
WHERE {
  ?pathway a wp:Pathway ;
           dcterms:identifier "${pathwayID}" .

  ?interaction a wp:Interaction ;
               dcterms:isPartOf ?pathway ;
               wp:source ?source ;
               wp:target ?target .

  ?source rdfs:label ?sourceLabel .
  ?target rdfs:label ?targetLabel .

  OPTIONAL { ?source a ?sourceType . }
  OPTIONAL { ?target a ?targetType . }
  OPTIONAL { ?interaction a ?interactionType . }
}
`;

// =====================================================
//  TABLE HANDLING (from lionel.js)
// =====================================================
function clearTable() {
  const tbody = document.getElementById("resultsBody");
  if (tbody) tbody.innerHTML = "";
}

function fillTableFromGraph(tableRows) {
  const tbody = document.getElementById("resultsBody");
  if (!tbody) return;

  tableRows.forEach(row => {
    const tr = document.createElement("tr");
    tr.dataset.sourceId = row.sourceId;
    tr.dataset.targetId = row.targetId;

    tr.innerHTML = `
      <td>${row.source}</td>
      <td>${row.target}</td>
      <td><a href="${row.url}" target="_blank" rel="noopener noreferrer">Link to source</a></td>
    `;
    tbody.appendChild(tr);
  });
}

function highlightRowsForNode(nodeId) {
  const tbody = document.getElementById("resultsBody");
  if (!tbody) return;

  tbody.querySelectorAll("tr").forEach(tr => {
    tr.classList.remove("highlight");
    if (tr.dataset.sourceId === nodeId) tr.classList.add("highlight");
  });
}

// =====================================================
//  ROWS → GRAPH (from original chat.js)
// =====================================================
function convertToGraph(rows, labelToIri) {
  const nodeMap = new Map();
  const links = [];
  const tableRows = [];
  const edgeSet = new Set();

  function getNode(label) {
    const n = normalizeLabel(label, nodeMap);
    let node = nodeMap.get(n.key);
    if (!node) {
      node = { id: n.key, label: n.label };
      nodeMap.set(n.key, node);
    } else {
      node.label = n.label;
    }
    return node;
  }

  rows.forEach(r => {
    const sNode = getNode(r.sourceLabel.value);
    const tNode = getNode(r.targetLabel.value);
    const key = sNode.id + "||" + tNode.id;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    links.push({
      source: sNode.id,
      target: tNode.id,
      label: r.interactionLabel ? r.interactionLabel.value : "",
      type: r.interactionType ? r.interactionType.value : ""
    });
    const iri = labelToIri.get(sNode.label) || "#";
    tableRows.push({
      source: sNode.label,
      target: tNode.label,
      url: iri,
      sourceId: sNode.id,
      targetId: tNode.id
    });
  });

  const nodes = Array.from(nodeMap.values());
  const hasSource = new Set(tableRows.map(r => r.sourceId));
  nodes.forEach(n => {
    if (!hasSource.has(n.id)) {
      const iri = labelToIri.get(n.label) || "#";
      tableRows.push({
        source: n.label,
        target: "(no outgoing interaction)",
        url: iri,
        sourceId: n.id,
        targetId: ""
      });
    }
  });

  return { nodes, links, tableRows };
}

// =====================================================
//  GRAPH DRAWING (static layered layout from original chat.js)
// =====================================================
function clearGraph() {
  svg.selectAll("*").remove();
}

function shiftedTarget(d, offset) {
  const dx = d.target.x - d.source.x;
  const dy = d.target.y - d.source.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  return {
    x: d.target.x - (dx / len) * offset,
    y: d.target.y - (dy / len) * offset
  };
}

function drawGraph(graph) {
  const nodes = graph.nodes;
  const links = graph.links;

  svg.selectAll("*").remove();

  const deg = new Map();
  nodes.forEach(n => deg.set(n.id, { in: 0, out: 0 }));
  links.forEach(l => {
    deg.get(l.source).out++;
    deg.get(l.target).in++;
  });

  const layer = new Map();
  nodes.forEach(n => {
    const d = deg.get(n.id);
    if (d.in === 0 && d.out > 0) layer.set(n.id, 0);       // pure sources (top)
    else layer.set(n.id, 1);                              // others for now
  });

  // relax layers so targets are at least 1 below their sources
  let changed = true;
  while (changed) {
    changed = false;
    links.forEach(l => {
      const sL = layer.get(l.source);
      const tL = layer.get(l.target);
      if (tL <= sL) {
        layer.set(l.target, sL + 1);
        changed = true;
      }
    });
  }

  const maxLayer = Math.max(...layer.values());
  const layerNodes = [];
  for (let i = 0; i <= maxLayer; i++) layerNodes.push([]);
  nodes.forEach(n => layerNodes[layer.get(n.id)].push(n));

  const marginX = 40, marginY = 40;
  const stepY = (height - 2 * marginY) / Math.max(1, maxLayer);
  layerNodes.forEach((ln, i) => {
    if (!ln.length) return;
    const stepX = (width - 2 * marginX) / (ln.length + 1);
    ln.forEach((n, j) => {
      n.x = marginX + stepX * (j + 1);
      n.y = marginY + stepY * i;
    });
  });

  // convert link endpoints from ids to node objects
  const nodesById = new Map(nodes.map(n => [n.id, n]));
  links.forEach(l => {
    l.source = nodesById.get(l.source);
    l.target = nodesById.get(l.target);
  });

  svg.append("defs")
    .append("marker")
    .attr("id", "arrow")
    .attr("viewBox", "0 0 10 10")
    .attr("refX", 10)
    .attr("refY", 5)
    .attr("markerWidth", 10)
    .attr("markerHeight", 10)
    .attr("orient", "auto")
    .append("path")
    .attr("d", "M 0 0 L 10 5 L 0 10 z")
    .attr("fill", "#555");

  const link = svg.append("g")
    .attr("class", "links")
    .selectAll("line")
    .data(links)
    .enter()
    .append("line")
    .attr("class", "link")
    .attr("marker-end", "url(#arrow)");

  const node = svg.append("g")
    .attr("class", "nodes")
    .selectAll("g")
    .data(nodes)
    .enter()
    .append("g")
    .attr("class", "node");

  node.append("circle").attr("r", 15);
  node.append("text").attr("x", 18).attr("y", 3).text(d => d.label);

  link.append("title").text(d => (d.label || "Interaction") + (d.type ? ` (${d.type})` : ""));

  function updatePositions() {
    link
      .attr("x1", d => d.source.x)
      .attr("y1", d => d.source.y)
      .attr("x2", d => shiftedTarget(d, 20).x)
      .attr("y2", d => shiftedTarget(d, 20).y);
    node.attr("transform", d => `translate(${d.x},${d.y})`);
  }

  node.on("click", (e, d) => highlightRowsForNode(d.id));
  updatePositions();

  node.call(
    d3.drag()
      .on("drag", (e, d) => {
        d.x = e.x;
        d.y = e.y;
        updatePositions();
      })
  );
}

// =====================================================
//  CUSTOM EDGES (from original chat.js)
// =====================================================
function addCustomEdges(graph, edges, labelToIri) {
  edges.forEach(edge => {
    function getNode(label) {
      const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
      const n = normalizeLabel(label, nodeMap);
      let node = graph.nodes.find(g => g.id === n.key);
      if (!node) {
        node = { id: n.key, label: n.label };
        graph.nodes.push(node);
      } else {
        node.label = n.label;
      }
      return node;
    }
    const sNode = getNode(edge.source);
    const tNode = getNode(edge.target);
    graph.links.push({
      source: sNode.id,
      target: tNode.id,
      label: "custom",
      type: "custom"
    });
    const iri = labelToIri.get(sNode.label) || "#";
    graph.tableRows.push({
      source: sNode.label,
      target: tNode.label,
      url: iri,
      sourceId: sNode.id,
      targetId: tNode.id
    });
  });
}

// =====================================================
//  MAIN RUN (from lionel.js, adapted to original graph)
// =====================================================
loadBtn.addEventListener("click", run);
pathwaySelect.addEventListener("change", run);
run();

async function run() {
  const pathwayId = pathwaySelect.value || "WP17";
  pathwayLabel.textContent = pathwayId;
  statusEl.textContent = " Loading data…";
  clearGraph();
  clearTable();

  try {
    const headers = { Accept: "application/sparql-results+json" };
    const query = getQuery(pathwayId);
    const res = await fetch(endpoint + "?query=" + encodeURIComponent(query), { headers });

    if (!res.ok) throw new Error("HTTP " + res.status);

    const json = await res.json();

    // Use Lionel's deduplication on the raw bindings
    const deduped = removeDuplicateInteractions3(json.results.bindings) || [];

    // Build a label → IRI map from both sources and targets
    const iriMap = new Map();
    json.results.bindings.forEach(row => {
      if (row.sourceLabel && row.source) {
        iriMap.set(row.sourceLabel.value, row.source.value);
      }
      if (row.targetLabel && row.target) {
        iriMap.set(row.targetLabel.value, row.target.value);
      }
    });

    const graph = convertToGraph(deduped, iriMap);

    // Custom edges per pathway, as before
    if (pathwayId === "WP17") {
      addCustomEdges(graph, [
        { source: "PIP", target: "AKT-1" },
        { source: "ProteinA", target: "ProteinB" }
      ], iriMap);
    } else if (pathwayId === "WP3855") {
      addCustomEdges(graph, [{ source: "GeneM", target: "GeneN" }], iriMap);
    }

    fillTableFromGraph(graph.tableRows);
    drawGraph(graph);
    statusEl.textContent = " Done.";
  } catch (e) {
    console.error(e);
    statusEl.textContent = " Error: " + e.message;
  }
}
