const endpoint = "https://sparql.wikipathways.org/sparql";
const aliasMap = {
  "CDK2": "CyclinDependentKinase2",
  "AKT-1": "AKT1"
};
// GLOBAL accumulation
const globalFreq = new Map();         // gene → { count, pathways:Set }
const loadedPathways = new Set();     // pathways we've already counted


// SVG & DOM references
const svg = d3.select("#graph");// create space for the graph
const width = svg.node().clientWidth;
const height = svg.node().clientHeight;
const statusEl = document.getElementById("status");//recall elements from the HTML
const loadBtn = document.getElementById("loadBtn");
const pathwaySelect = document.getElementById("pathwaySelect");
const pathwayLabel = document.getElementById("pathwayLabel");

// =====================================================
//  DEDUPLICATION (from lionel.js)
// =====================================================
function removeDuplicateInteractions3(rows) {
  const seenEdges = new Set();       // stores the edges to avoid duplicates
  const canonicalLabel = new Map();  // URI -> chosen label
  const result = [];  //will hold the results

  rows.forEach(inter => {   //loop trough each element in the rows
    let src = inter?.source?.value;
    let tgt = inter?.target?.value;  //extract the url associeted to the source and target
    let srcLabel = inter?.sourceLabel?.value;
    let tgtLabel = inter?.targetLabel?.value; //extract the name associeted tot the source and target

    if (!src || !tgt) return; // if either src or tgt is missing skip the iteration

    // canonicalize source
    if (!canonicalLabel.has(src) && srcLabel) { //check if the list does not already have the src and if it has an associeted label
      canonicalLabel.set(src, srcLabel);  //if not yet in the list then add it 
    }
    if (!canonicalLabel.has(src)) {
      canonicalLabel.set(src, src); // fallback
    }
    srcLabel = canonicalLabel.get(src); // Get a consistent label for src: use human-readable if available, otherwise fallback to the URI

    // canonicalize target
    if (!canonicalLabel.has(tgt) && tgtLabel) {
      canonicalLabel.set(tgt, tgtLabel);
    }
    if (!canonicalLabel.has(tgt)) {
      canonicalLabel.set(tgt, tgt); // fallback
    }
    tgtLabel = canonicalLabel.get(tgt);

    // deduplicate edge
    const edgeKey = src + "||" + tgt; //define a source target pair ID 
    if (seenEdges.has(edgeKey)) return; // check if pair ID is not yet in the list
    seenEdges.add(edgeKey); //add the iD to the list 
    result.push({ //clean duplicate version of the original row
      ...inter,
      sourceLabel: { value: srcLabel },
      targetLabel: { value: tgtLabel }
    });
  });

  return result;
}

// =====================================================
//  LABEL NORMALIZATION (from original chat.js)
// =====================================================
function normalizeLabel(label, nodeMap) {
  const clean = label.trim().toUpperCase().replace(/[^A-Z0-9/]/g, "");//removes whitespace, converts to uppercase, removes all non-alphanumeric characters (appart from "/")
  const core0 = clean.split("/")[0]; //take the first part of the label separreted by /
  const core = aliasMap[core0] || core0; //define the name as either core0 or from the alias map
  let key = core;

  for (const [k] of nodeMap) { // looks at keys in the map (names )
    const min = Math.min(k.length, core.length); //Finds the shorter of the two strings
    if (min >= 5 && (k.startsWith(core) || core.startsWith(k))) {//only consider matches if at least 3 characters long and the strings start with each other.
      key = k;//assign label 
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
//  SPARQL QUERY (new one from lionel.js)
// =====================================================
function getQuery(pathwayID) {
  return `
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
    ?pathwayTitle
WHERE {
  ?pathway a wp:Pathway ;
           dcterms:identifier "${pathwayID}";
           dc:title ?pathwayTitle .

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
}

// =====================================================
//  TABLE HANDLING
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
    if (tr.dataset.sourceId === nodeId) {
      tr.classList.add("highlight");
    }
  });
}

// =====================================================
//  CONVERT RAW ROWS → GRAPH
// =====================================================
function convertToGraph(rows, labelToIri) {
  const nodeMap = new Map();
  const links = [];
  const tableRows = [];
  const edgeSet = new Set();

  const currentPathway = pathwaySelect.value || "UNKNOWN";


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
    if (!r.sourceLabel || !r.targetLabel) return;

    const sourceLabel = r.sourceLabel.value || "";
    const targetLabel = r.targetLabel.value || "";

    const sNode = getNode(sourceLabel);
    const tNode = getNode(targetLabel);

    // ← Update global frequency only if this pathway hasn't been counted yet
    if (!loadedPathways.has(currentPathway)) {
      if (!globalFreq.has(sNode.id)) globalFreq.set(sNode.id, { count: 0, pathways: new Set() });
      if (!globalFreq.has(tNode.id)) globalFreq.set(tNode.id, { count: 0, pathways: new Set() });

      globalFreq.get(sNode.id).pathways.add(currentPathway);
      globalFreq.get(tNode.id).pathways.add(currentPathway);

      globalFreq.get(sNode.id).count = globalFreq.get(sNode.id).pathways.size;
      globalFreq.get(tNode.id).count = globalFreq.get(tNode.id).pathways.size;
    }


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

      // ← NEW: also count isolated nodes
      if (!loadedPathways.has(currentPathway)) {
        if (!globalFreq.has(n.id)) globalFreq.set(n.id, { count: 0, pathways: new Set() });
        globalFreq.get(n.id).pathways.add(currentPathway);
        globalFreq.get(n.id).count = globalFreq.get(n.id).pathways.size;
      }

    }
  });

  return { nodes, links, tableRows};  // ← return it!
}

// =====================================================
//  GRAPH DRAWING – hierarchical layout (longest-path style)
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
  const rawLinks = graph.links;

  svg.selectAll("*").remove();

  if (!nodes || nodes.length === 0) {
    statusEl.textContent = " No interactions found for this pathway.";
    return;
  }

  // links expressed as ids (so we can do graph algorithms)
  const edges = rawLinks.map(l => ({
    sourceId: typeof l.source === "string" ? l.source : l.source.id,
    targetId: typeof l.target === "string" ? l.target : l.target.id,
    label: l.label,
    type: l.type
  }));

  const nodesById = new Map(nodes.map(n => [n.id, n]));

  // --- indegree / adjacency / reverse adjacency ---
  const indegree = new Map();
  const adjacency = new Map();
  const revAdj = new Map();

  nodes.forEach(n => {
    indegree.set(n.id, 0);
    adjacency.set(n.id, []);
    revAdj.set(n.id, []);
  });

  edges.forEach(e => {
    if (!indegree.has(e.targetId)) indegree.set(e.targetId, 0);
    indegree.set(e.targetId, (indegree.get(e.targetId) || 0) + 1);

    if (!adjacency.has(e.sourceId)) adjacency.set(e.sourceId, []);
    adjacency.get(e.sourceId).push(e.targetId);

    if (!revAdj.has(e.targetId)) revAdj.set(e.targetId, []);
    revAdj.get(e.targetId).push(e.sourceId);
  });

  // --- Longest-path style layering (with cycle fallback) ---
  const layer = new Map();
  nodes.forEach(n => layer.set(n.id, 0));

  const in2 = new Map();
  nodes.forEach(n => in2.set(n.id, indegree.get(n.id) || 0));

  const queue = [];
  const visited = new Set();

  nodes.forEach(n => {
    if ((in2.get(n.id) || 0) === 0) queue.push(n.id);
  });
  if (queue.length === 0) {
    // no true sources (pure cycles); just pick all as starting points
    nodes.forEach(n => queue.push(n.id));
  }

  while (queue.length) {
    const u = queue.shift();
    if (visited.has(u)) continue;
    visited.add(u);

    const baseLayer = layer.get(u) || 0;
    const neigh = adjacency.get(u) || [];
    neigh.forEach(v => {
      const cur = layer.get(v) || 0;
      const next = baseLayer + 1;
      if (next > cur) layer.set(v, next);

      in2.set(v, (in2.get(v) || 1) - 1);
      if (in2.get(v) === 0 && !visited.has(v)) queue.push(v);
    });
  }

  // nodes still unvisited: put them just below their predecessors (or at 0)
  nodes.forEach(n => {
    if (visited.has(n.id)) return;
    const preds = revAdj.get(n.id) || [];
    let maxPred = -1;
    preds.forEach(p => {
      const lp = layer.get(p);
      if (lp != null && lp > maxPred) maxPred = lp;
    });
    if (maxPred >= 0) layer.set(n.id, maxPred + 1);
    else layer.set(n.id, 0);
  });

  // --- group nodes by layer ---
  let maxLayer = 0;
  layer.forEach(v => {
    if (v > maxLayer) maxLayer = v;
  });

  const layerNodes = [];
  for (let i = 0; i <= maxLayer; i++) layerNodes.push([]);
  nodes.forEach(n => {
    const l = layer.get(n.id) || 0;
    if (!layerNodes[l]) layerNodes[l] = [];
    layerNodes[l].push(n);
  });

  // --- node radius: shrink automatically if a layer is very crowded ---
  const marginX = 40;
  const marginY = 40;

  let maxPerLayer = 0;
  layerNodes.forEach(ln => {
    if (ln && ln.length > maxPerLayer) maxPerLayer = ln.length;
  });
  const stepXmin = (width - 2 * marginX) / ((maxPerLayer + 1) || 1);
  const nodeRadius = Math.max(4, Math.min(15, stepXmin * 0.4));

  const stepY = (height - 2 * marginY) / Math.max(1, maxLayer || 1);

  // assign coordinates
  layerNodes.forEach((ln, i) => {
    if (!ln || !ln.length) return;
    const stepX = (width - 2 * marginX) / (ln.length + 1);
    ln.forEach((n, j) => {
      n.x = marginX + stepX * (j + 1);
      n.y = marginY + stepY * i;
    });
  });

  // --- convert edges to D3-friendly objects (source/target = node objects) ---
  edges.forEach(e => {
    e.source = nodesById.get(e.sourceId);
    e.target = nodesById.get(e.targetId);
  });

  // --- draw ---
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
    .data(edges)
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

  node.append("circle").attr("r", nodeRadius);
  node.append("text")
    .attr("x", nodeRadius + 3)
    .attr("y", 3)
    .text(d => d.label);

  link.append("title")
    .text(d => (d.label || "Interaction") + (d.type ? ` (${d.type})` : ""));

  function updatePositions() {
    link
      .attr("x1", d => d.source.x)
      .attr("y1", d => d.source.y)
      .attr("x2", d => shiftedTarget(d, nodeRadius + 5).x)
      .attr("y2", d => shiftedTarget(d, nodeRadius + 5).y);

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
//  CUSTOM EDGES (same idea as original)
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

function renderFrequencyTable(freqTable) {
  const container = document.getElementById("frequency-table");
  if (!container) return;

  let html = `
    <table border="1" cellpadding="4" cellspacing="0">
      <thead>
        <tr>
          <th>Gene</th>
          <th>Count</th>
          <th>Pathways</th>
        </tr>
      </thead>
      <tbody>
  `;

  for (const row of freqTable) {
    html += `
      <tr>
        <td>${row.gene}</td>
        <td>${row.count}</td>
        <td>${row.pathways.join(", ")}</td>
      </tr>
    `;
  }

  html += "</tbody></table>";
  container.innerHTML = html;
}

function drawGeneFrequencyChart(barData) {
  // --- Gather all pathways dynamically ---
  const allPathways = new Set();
  barData.forEach(d => Object.keys(d).forEach(k => { if (k !== "gene") allPathways.add(k); }));
  const pathways = Array.from(allPathways);

  // --- Sort barData by total count descending ---
  barData.forEach(d => d.total = pathways.reduce((sum, k) => sum + (d[k] || 0), 0));
  barData.sort((a, b) => b.total - a.total);

  // --- Dimensions ---
  const margin = { top: 60, right: 20, bottom: 30, left: 140 };
  const svgWidth = 700;
  const svgHeight = barData.length * 25 + margin.top + margin.bottom;

  const svg = d3.select("#frequency-chart")
    .attr("width", svgWidth)
    .attr("height", svgHeight)
    .html(""); // clear previous chart

  const width = svgWidth - margin.left - margin.right;
  const height = svgHeight - margin.top - margin.bottom;

  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  // --- Scales ---
  const x = d3.scaleLinear()
    .domain([0, d3.max(barData, d => d.total)])
    .range([0, width]);

  const y = d3.scaleBand()
    .domain(barData.map(d => d.gene))
    .range([0, height])
    .padding(0.1);

  const color = d3.scaleOrdinal(d3.schemeCategory10).domain(pathways);

  // --- Stack data ---
  const stack = d3.stack()
    .keys(pathways)
    .value((d, key) => d[key] || 0);

  const series = stack(barData);

  // --- Tooltip (single div) ---
  let tooltip = d3.select(".tooltip");
  if (tooltip.empty()) {
    tooltip = d3.select("body").append("div")
      .attr("class", "tooltip")
      .style("position", "absolute")
      .style("background", "#fff")
      .style("padding", "6px 10px")
      .style("border", "1px solid #aaa")
      .style("border-radius", "4px")
      .style("pointer-events", "none")
      .style("opacity", 0);
  }

  // --- Draw bars ---
  g.selectAll("g.series")
    .data(series)
    .enter()
    .append("g")
    .attr("fill", d => color(d.key))
    .selectAll("rect")
    .data(d => d)
    .enter()
    .append("rect")
    .attr("y", d => y(d.data.gene))
    .attr("x", d => x(d[0]))
    .attr("width", d => x(d[1]) - x(d[0]))
    .attr("height", y.bandwidth())
    .on("mouseover", (event, d) => {
      const activePathways = pathways.filter(k => d.data[k] > 0);
      tooltip.transition().duration(100).style("opacity", 0.9);
      tooltip.html(`<strong>${d.data.gene}</strong><br>Pathways: ${activePathways.join(", ")}`);
    })
    .on("mousemove", event => {
      tooltip.style("left", (event.pageX + 10) + "px")
             .style("top", (event.pageY - 20) + "px");
    })
    .on("mouseout", () => tooltip.transition().duration(200).style("opacity", 0));

  // --- Axes ---
  g.append("g").call(d3.axisLeft(y));
  g.append("g").attr("transform", `translate(0,${height})`).call(d3.axisBottom(x));

  // --- Legend ---
  const legend = svg.append("g")
    .attr("transform", `translate(${margin.left}, 20)`);

  pathways.forEach((p, i) => {
    const gLeg = legend.append("g").attr("transform", `translate(${i * 120},0)`);
    gLeg.append("rect").attr("width", 15).attr("height", 15).attr("fill", color(p));
    gLeg.append("text").attr("x", 20).attr("y", 12).text(p);
  });
}



// =====================================================
//  MAIN RUN
// =====================================================
const pathwayTitle = document.getElementById("pathwayTitle");
loadBtn.addEventListener("click", run);
pathwaySelect.addEventListener("change", run);

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
    pathwayTitle.textContent = json.results.bindings?.[0]?.pathwayTitle?.value ?? "No title";

    // Deduplicate using Lionel's function
    const deduped = removeDuplicateInteractions3(json.results.bindings || []);

    // Build label → IRI map from raw rows (sources + targets)
    const iriMap = new Map();
    (json.results.bindings || []).forEach(row => {
      if (row.sourceLabel && row.source) {
        iriMap.set(row.sourceLabel.value, row.source.value);
      }
      if (row.targetLabel && row.target) {
        iriMap.set(row.targetLabel.value, row.target.value);
      }
    });

    const graph = convertToGraph(deduped, iriMap);
    // Build a table from the global frequency
    const barData = [];
    for (const [gene, data] of globalFreq.entries()) {
      const geneObj = { gene };
      data.pathways.forEach(p => { geneObj[p] = 1 }); // each pathway = 1 count
      barData.push(geneObj);
    }

    drawGeneFrequencyChart(barData);

    
    loadedPathways.add(pathwayId);

    // Optional hard-coded extra edges
    if (pathwayId === "WP17") {
      addCustomEdges(graph, [
        { source: "PIP", target: "Complex A" },
        { source: "PDK1", target: "Complex A" }, 
        { source: "Complex A", target: "DAF-16/FOXO"},
        { source: "DAF-16/FOXO", target: "Complex B"}
      ], iriMap);
    } else if (pathwayId === "WP3675") {
      addCustomEdges(graph, [
        { source: "ActRIIB", target: "SMAD Complex" },
        { source: "SMAD Complex", target: "AKT1" }, 
        { source: "SMAD Complex", target: "MTOR Complex"},
        { source: "MTOR Complex", target: "S6K"},
        { source: "MTOR Complex", target: "FoxO"},
        { source: "PLD1", target: "MTOR Complex"},
        { source: "AMPK", target: "MTOR Complex"},
        { source: "Amino Acids", target: "MTOR Complex"},
        { source: "AKT1", target: "MTOR Complex"},
        { source: "IGF1", target: "IGF1rec"},
      ], iriMap);
    } else if (pathwayId === "WP3958") {
      addCustomEdges(graph, [
        { source: "GPR40-GNA11", target: "Phospholipase C" },
        { source: "Phospholipase C", target: "DAG" }, 
        { source: "Phospholipase C", target: "IP3"},
        { source: "Ca2+ efflux", target: "Insulin exocytosis"},
        { source: "PKD1", target: "Unknown target genes"},
        { source: "Unknown target genes", target: "F-acting remodeling enables insulin exocytosis"},
        ], iriMap);
    }else if (pathwayId === "WP4229") {
      addCustomEdges(graph, [
        { source: "Mapk3", target: "TSC complex" },
        { source: "Akt", target: "TSC complex" }, 
        { source: "TSC Complex", target: "Rheb"},
        { source: "Akt", target: "Akt1s1"},
        { source: "Akt1s1", target: "mTOR complex"},
        { source: "Rheb", target: "mTOR complex"},
        { source: "mTOR", target: "4eBP"},
        { source: "mTOR complex", target: "S6K"},
        { source: "4eBP", target: "Eif4e"},
        { source: "mTOR complex", target: "LARP1"},
        { source: "mTOR complex", target: "Grb10"},
        { source: "mTOR complex", target: "FoxK1"},
        { source: "mTOR complex", target: "Ndrg1"},
        ], iriMap);
    }
    fillTableFromGraph(graph.tableRows);
    drawGraph(graph);
    statusEl.textContent = " Done.";
  } catch (e) {
    console.error(e);
    statusEl.textContent = " Error: " + e.message;
  }
}




