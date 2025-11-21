// =====================================================
//  ALIAS + NORMALIZATION
// =====================================================
const aliasMap = {}; // Add manual aliases if needed

function removeDuplicateInteractions3(rows) {
  const seenEdges = new Set();       // (src || tgt) duplicate remover
  const canonicalLabel = new Map();  // <-- FIXED: map URI → chosen label
  const result = [];

  rows.forEach(inter => {
    let src = inter?.source?.value;
    let tgt = inter?.target?.value;
    let srcLabel = inter?.sourceLabel?.value;
    let tgtLabel = inter?.targetLabel?.value;

    if (!src || !tgt) return;

    // ---------- FIXED: canonicalize SOURCE ----------
    if (!canonicalLabel.has(src)) {
      canonicalLabel.set(src, srcLabel);   // first label becomes canonical
    }
    srcLabel = canonicalLabel.get(src);    // use canonical form

    // ---------- FIXED: canonicalize TARGET ----------
    if (!canonicalLabel.has(tgt)) {
      canonicalLabel.set(tgt, tgtLabel);
    }
    tgtLabel = canonicalLabel.get(tgt);

    // ---------- DEDUPLICATION ----------
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


function normalizeLabel(label, existing = {}, aliasMap = {}) {
  const clean = label.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const core = clean.split("/")[0];
  const finalCore = aliasMap[core] || core;

  let canonical = finalCore;
  for (const key of Object.keys(existing)) {
    const min = Math.min(key.length, finalCore.length);
    if (min >= 3 && (key.startsWith(finalCore) || finalCore.startsWith(key))) {
      canonical = key;
      break;
    }
  }

  const current = existing[canonical];
  if (!current) return { key: canonical, label };

  const cleanCurrent = current.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const extraCur = cleanCurrent.startsWith(finalCore) ? cleanCurrent.slice(finalCore.length) : "";
  const extraNew = clean.startsWith(finalCore) ? clean.slice(finalCore.length) : "";

  const curNum = /^[0-9]+$/.test(extraCur);
  const newNum = /^[0-9]+$/.test(extraNew);

  let better = current;
  if (!extraCur && newNum) better = current;
  else if (!extraNew && curNum) better = label;
  else better = label.length > current.length ? label : current;

  return { key: canonical, label: better };
}

// =====================================================
//  SPARQL ENDPOINT + QUERY BUILDER
// =====================================================
const endpoint = "https://sparql.wikipathways.org/sparql";

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

function buildInteractionQuery(pathwayId) {
  return `
    PREFIX wp: <http://vocabularies.wikipathways.org/wp#>
    PREFIX dcterms: <http://purl.org/dc/terms/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

    SELECT DISTINCT ?sourceLabel ?targetLabel ?interactionLabel ?interactionType
    WHERE {
      ?pathway a wp:Pathway ;
               dcterms:identifier "${pathwayId}" .
      ?interaction a wp:Interaction ;
                   dcterms:isPartOf ?pathway ;
                   wp:source ?source ;
                   wp:target ?target .
      ?source rdfs:label ?sourceLabel .
      ?target rdfs:label ?targetLabel .
      OPTIONAL { ?interaction rdfs:label ?interactionLabel . }
      OPTIONAL { ?interaction wp:interactionType ?interactionType . }
    }
  `;
}

// =====================================================
//  FETCH GENE PRODUCTS
// =====================================================
async function fetchGeneProducts(pathwayId) {
  const query = `
    PREFIX wp: <http://vocabularies.wikipathways.org/wp#>
    PREFIX dcterms: <http://purl.org/dc/terms/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

    SELECT DISTINCT ?geneProduct ?geneProductLabel ?pathway
    WHERE {
      ?geneProduct a wp:GeneProduct .
      ?geneProduct rdfs:label ?geneProductLabel .
      ?geneProduct dcterms:isPartOf ?pathway .
      ?pathway a wp:Pathway .
      ?pathway dcterms:identifier "${pathwayId}" .
    }
  `;
  const res = await fetch(endpoint + "?query=" + encodeURIComponent(query), {
    headers: { "Accept": "application/sparql-results+json" }
  });
  if (!res.ok) throw new Error("GeneProduct HTTP " + res.status);
  const data = await res.json();
  const map = new Map();
  data.results.bindings.forEach(row => {
    map.set(row.geneProductLabel.value, row.geneProduct.value);
  });
  return map;
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
    if (tr.dataset.sourceId === nodeId) tr.classList.add("highlight");
  });
}

// =====================================================
//  ROWS → NODES + LINKS + TABLE
// =====================================================
function convertToGraph(rows, labelToIri) {
  const nodeMap = new Map();
  const links = [];
  const tableRows = [];
  const edgeKeySet = new Set();

  function getNode(label) {
    const existing = {};
    nodeMap.forEach((v, k) => (existing[k] = v.label));
    const norm = normalizeLabel(label, existing, aliasMap);
    let node = nodeMap.get(norm.key);
    if (!node) {
      node = { id: norm.key, label: norm.label };
      nodeMap.set(norm.key, node);
    } else {
      node.label = norm.label;
    }
    return node;
  }

  for (const row of rows) {
    const sourceNode = getNode(row.sourceLabel.value);
    const targetNode = getNode(row.targetLabel.value);

    const edgeKey = sourceNode.id + "||" + targetNode.id;
    if (!edgeKeySet.has(edgeKey)) {
      edgeKeySet.add(edgeKey);
      links.push({
        source: sourceNode.id,
        target: targetNode.id,
        label: row.interactionLabel ? row.interactionLabel.value : "",
        type: row.interactionType ? row.interactionType.value : "",
      });

      const sourceIri = labelToIri.get(sourceNode.label) || "#";
      tableRows.push({
        source: sourceNode.label,
        target: targetNode.label,
        url: sourceIri,
        sourceId: sourceNode.id,
        targetId: targetNode.id
      });
    }
  }

  const nodesArray = Array.from(nodeMap.values());
  const hasSourceRow = new Set(tableRows.map(r => r.sourceId));

  nodesArray.forEach(node => {
    if (!hasSourceRow.has(node.id)) {
      const iri = labelToIri.get(node.label) || "#";
      tableRows.push({
        source: node.label,
        target: "(no outgoing interaction)",
        url: iri,
        sourceId: node.id,
        targetId: "",
      });
    }
  });

  return { nodes: nodesArray, links, tableRows };
}

// =====================================================
//  DRAW GRAPH
// =====================================================
const svg = d3.select("#graph");
const width = svg.node().clientWidth;
const height = svg.node().clientHeight;

function clearGraph() {
  svg.selectAll("*").remove();
}

function drawGraph(graph) {
  const nodes = graph.nodes;
  const links = graph.links;

  svg.selectAll("*").remove();

  svg.append("defs").append("marker")
    .attr("id", "arrow")
    .attr("viewBox", "0 -5 10 10")
    .attr("refX", 15)
    .attr("refY", 0)
    .attr("markerWidth", 6)
    .attr("markerHeight", 6)
    .attr("orient", "auto")
    .append("path")
    .attr("d", "M0,-5L10,0L0,5")
    .attr("fill", "#888");

  const link = svg.append("g").attr("class", "links")
    .selectAll("line")
    .data(links)
    .enter()
    .append("line")
    .attr("class", "link");

  const node = svg.append("g").attr("class", "nodes")
    .selectAll("g")
    .data(nodes)
    .enter()
    .append("g")
    .attr("class", "node");

  node.append("circle").attr("r", 15);
  node.append("text").attr("x", 18).attr("y", 3).text(d => d.label);

  link.append("title").text(d => (d.label || "Interaction") + (d.type ? ` (${d.type})` : ""));
  node.on("click", (event, d) => highlightRowsForNode(d.id));

  const simulation = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id(d => d.id).distance(120))
    .force("charge", d3.forceManyBody().strength(-200))
    .force("center", d3.forceCenter(width / 2, height / 2));

  const margin = 30;
  simulation.on("tick", () => {
    nodes.forEach(d => {
      d.x = Math.max(margin, Math.min(width - margin, d.x));
      d.y = Math.max(margin, Math.min(height - margin, d.y));
    });
    link.attr("x1", d => d.source.x)
        .attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x)
        .attr("y2", d => d.target.y);
    node.attr("transform", d => `translate(${d.x},${d.y})`);
  });

  node.call(d3.drag()
    .on("start", (event, d) => { if (!event.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
    .on("drag", (event, d) => { d.fx = event.x; d.fy = event.y; })
    .on("end", (event, d) => { if (!event.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }));
}

// =====================================================
//  ADD CUSTOM EDGES
// =====================================================
function addCustomEdges(graphData, edges, labelToIri) {
  edges.forEach(edge => {
    // Add nodes if missing
    function getNode(label) {
      const existing = {};
      graphData.nodes.forEach(n => (existing[n.id] = n.label));
      const norm = normalizeLabel(label, existing, aliasMap);
      let node = graphData.nodes.find(n => n.id === norm.key);
      if (!node) {
        node = { id: norm.key, label: norm.label };
        graphData.nodes.push(node);
      }
      return node;
    }

    const sourceNode = getNode(edge.source);
    const targetNode = getNode(edge.target);

    // Add link
    graphData.links.push({
      source: sourceNode.id,
      target: targetNode.id,
      label: "custom",
      type: "custom"
    });

    // Add table row
    const sourceIri = labelToIri.get(sourceNode.label) || "#";
    graphData.tableRows.push({
      source: sourceNode.label,
      target: targetNode.label,
      url: sourceIri,
      sourceId: sourceNode.id,
      targetId: targetNode.id
    });
  });
}


// =====================================================
//  MAIN RUN
// =====================================================
const statusEl = document.getElementById("status");
const loadBtn = document.getElementById("loadBtn");
const pathwaySelect = document.getElementById("pathwaySelect");
const pathwayLabel = document.getElementById("pathwayLabel");

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
    const headers = { "Accept": "application/sparql-results+json" };
    
    

    const url = endpoint + '?query=' + encodeURIComponent(getQuery(pathwayId));
    const res = await fetch(url, { headers: { Accept: 'application/sparql-results+json' } });

    if (!res.ok) throw new Error(res.statusText);

    const data = await res.json();

    let results = removeDuplicateInteractions3(data.results.bindings) || [];
    const geneProductMap = new Map();
    data.results.bindings.forEach(row => {
    geneProductMap.set(row.sourceLabel.value, row.source.value);
    });

    const graphData = convertToGraph(results, geneProductMap);

    // =====================================================
    //  CUSTOM INTERACTIONS PER PATHWAY
    // =====================================================
    if (pathwayId === "WP17") {
      addCustomEdges(graphData, [
        { source: "PIP", target: "AKT-1" },
        { source: "ProteinA", target: "ProteinB" }
      ], geneProductMap);
    } else if (pathwayId === "WP3855") {
      addCustomEdges(graphData, [
        { source: "GeneM", target: "GeneN" }
      ], geneProductMap);
    }

    // Update table and graph
    fillTableFromGraph(graphData.tableRows);
    drawGraph(graphData);


    statusEl.textContent = " Done.";
  } catch (e) {
    statusEl.textContent = " Error: " + e.message;
  }
}
