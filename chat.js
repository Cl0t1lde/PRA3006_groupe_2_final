// =====================================================
//  LABEL NORMALISATION + MERGING
// =====================================================

// Optional manual aliases if you ever need them in the future.
const aliasMap = {
  // Example of usage if needed:
  // "PIP3": "PIP",
};

// Normalize label to letters+digits, used for comparisons
function basicNormalize(label) {
  return label.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// 1) Take label like "DAF-18/PTEN" or "daf-18" or "PIP3"
// 2) Keep only part BEFORE the first "/" ("DAF-18", "daf-18", "PIP3")
// 3) Uppercase and remove punctuation → "DAF18", "DAF18", "PIP3"
function coreKeyFromLabel(label) {
  let core = label.split("/")[0];             // part before slash
  core = core.trim().toUpperCase();          // uppercase
  core = core.replace(/[^A-Z0-9]/g, "");     // remove non letters/digits
  if (aliasMap[core]) {
    core = aliasMap[core];
  }
  return core;
}

// Decide which key to use for a new coreKey given existing keys.
function chooseCanonicalKey(coreKey, existingKeys) {
  for (const existing of existingKeys) {
    const minLen = Math.min(existing.length, coreKey.length);
    if (
      minLen >= 3 &&
      (existing.startsWith(coreKey) || coreKey.startsWith(existing))
    ) {
      return existing; // reuse existing node
    }
  }
  return coreKey; // no close match -> new node
}

// Decide which label to keep when two labels refer to the same node.
function chooseBetterLabel(currentLabel, newLabel, coreKey) {
  const core = coreKey;
  const basicCurrent = basicNormalize(currentLabel);
  const basicNew = basicNormalize(newLabel);

  const extraCurrent = basicCurrent.startsWith(core)
    ? basicCurrent.slice(core.length)
    : "";
  const extraNew = basicNew.startsWith(core)
    ? basicNew.slice(core.length)
    : "";

  const extraCurrentDigitsOnly = extraCurrent !== "" && /^[0-9]+$/.test(extraCurrent);
  const extraNewDigitsOnly = extraNew !== "" && /^[0-9]+$/.test(extraNew);

  // Case 1: current is base (no extra), new is base+number -> keep current (PIP vs PIP3 -> PIP)
  if (extraCurrent === "" && extraNewDigitsOnly) {
    return currentLabel;
  }

  // Case 2: new is base (no extra), current is base+number -> keep new (PIP3 vs PIP -> PIP)
  if (extraNew === "" && extraCurrentDigitsOnly) {
    return newLabel;
  }

  // Otherwise: keep the more detailed label (longer string)
  if (newLabel.length > currentLabel.length) {
    return newLabel;
  } else {
    return currentLabel;
  }
}



// =====================================================
//  SPARQL ENDPOINT + QUERIES
// =====================================================

const endpoint = "https://sparql.wikipathways.org/sparql";

// 1) OLD interaction query: gives ALL interactions for WP17
const interactionQuery = `
  PREFIX wp: <http://vocabularies.wikipathways.org/wp#>
  PREFIX dcterms: <http://purl.org/dc/terms/>
  PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

  SELECT DISTINCT ?sourceLabel ?targetLabel ?interactionLabel ?interactionType
  WHERE {
    ?pathway a wp:Pathway ;
             dcterms:identifier "WP17" .

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

// 2) Your NEW query, used only to get IRIs for source/target
const linkQuery = `
  PREFIX wp:      <http://vocabularies.wikipathways.org/wp#>
  PREFIX dcterms: <http://purl.org/dc/terms/>
  PREFIX rdfs:    <http://www.w3.org/2000/01/rdf-schema#>

  SELECT DISTINCT
    ?sourceLabel
    ?targetLabel
    ?sourceLink
    ?targetLink
  WHERE {
    ?pathway a wp:Pathway ;
             dcterms:identifier "WP17" .

    ?interaction a wp:Interaction ;
                 dcterms:isPartOf ?pathway ;
                 wp:source ?source ;
                 wp:target ?target .

    ?source rdfs:label ?sourceLabel .
    ?target rdfs:label ?targetLabel .

    ?source a wp:GeneProduct ;
            dcterms:isPartOf ?pathway .
    ?target a wp:GeneProduct ;
            dcterms:isPartOf ?pathway .

    BIND(?source AS ?sourceLink)
    BIND(?target AS ?targetLink)
  }
`;



// =====================================================
//  HOOK INTO THE HTML
// =====================================================

const svg = d3.select("#graph");
const width = svg.node().clientWidth;   // CSS width
const height = svg.node().clientHeight; // CSS height
const statusEl = document.getElementById("status");
const loadBtn = document.getElementById("loadBtn");

loadBtn.addEventListener("click", run);
run(); // run once on page load



// =====================================================
//  MAIN: FETCH DATA + FILL TABLE + DRAW GRAPH
// =====================================================

async function run() {
  statusEl.textContent = " Loading data…";
  clearGraph();
  clearTable();

  try {
    const headers = { "Accept": "application/sparql-results+json" };

    // Fetch BOTH queries in parallel
    const [interRes, linkRes] = await Promise.all([
      fetch(endpoint + "?query=" + encodeURIComponent(interactionQuery), { headers }),
      fetch(endpoint + "?query=" + encodeURIComponent(linkQuery),       { headers })
    ]);

    if (!interRes.ok) throw new Error("Interaction HTTP " + interRes.status);
    if (!linkRes.ok)  throw new Error("Link HTTP " + linkRes.status);

    const [interJson, linkJson] = await Promise.all([
      interRes.json(),
      linkRes.json()
    ]);

    // Build label -> IRI map from link query
    const labelToIri = buildLabelToIriMap(linkJson);

    // Build merged nodes + unique edges + table rows from interaction query
    const graphData = convertToGraph(interJson.results.bindings, labelToIri);

    // 1) Fill the left table using the merged, deduped interactions
    fillTableFromGraph(graphData.tableRows);

    // 2) Draw the graph
    drawGraph(graphData);

    statusEl.textContent = " Done.";
  } catch (e) {
    statusEl.textContent = " Error: " + e.message;
  }
}



// =====================================================
//  BUILD LABEL → IRI MAP FROM LINK QUERY
// =====================================================

function buildLabelToIriMap(linkJson) {
  const map = new Map();
  const rows = linkJson.results.bindings;

  rows.forEach(row => {
    if (row.sourceLabel && row.sourceLink) {
      map.set(row.sourceLabel.value, row.sourceLink.value);
    }
    if (row.targetLabel && row.targetLink) {
      map.set(row.targetLabel.value, row.targetLink.value);
    }
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
    // store canonical ids so we can highlight by node id
    tr.dataset.sourceId = row.sourceId;
    tr.dataset.targetId = row.targetId;

    tr.innerHTML = `
      <td>${row.source}</td>
      <td>${row.target}</td>
      <td><a href="${row.url}" target="_blank" rel="noopener noreferrer">
            Link to source
          </a></td>
    `;
    tbody.appendChild(tr);
  });
}

// Highlight ONLY rows where this node is the SOURCE
function highlightRowsForNode(nodeId) {
  const tbody = document.getElementById("resultsBody");
  if (!tbody) return;

  const rows = tbody.querySelectorAll("tr");
  rows.forEach(tr => {
    tr.classList.remove("highlight");
    const sId = tr.dataset.sourceId;
    if (sId === nodeId) {
      tr.classList.add("highlight");
    }
  });
}



// =====================================================
//  ROWS → NODES + UNIQUE LINKS + TABLE ROWS
// =====================================================

function convertToGraph(rows, labelToIri) {
  // Map canonicalKey -> node object {id, label}
  const nodeMap = new Map();
  const links = [];
  const tableRows = [];

  // To avoid duplicated edges after merging
  const edgeKeySet = new Set();

  function getNode(label) {
    const coreKey = coreKeyFromLabel(label);
    const existingKeys = Array.from(nodeMap.keys());
    const canonicalKey = chooseCanonicalKey(coreKey, existingKeys);

    let node = nodeMap.get(canonicalKey);
    if (!node) {
      // First time we see this canonicalKey: create node
      node = { id: canonicalKey, label: label };
      nodeMap.set(canonicalKey, node);
    } else {
      // We've seen this "core" before (e.g. PIP first, then PIP3, or vice versa)
      node.label = chooseBetterLabel(node.label, label, coreKey);
    }
    return node;
  }

  for (const row of rows) {
    const sourceLabel = row.sourceLabel.value;
    const targetLabel = row.targetLabel.value;
    const interactionLabel = row.interactionLabel ? row.interactionLabel.value : "";
    const interactionType = row.interactionType ? row.interactionType.value : "";

    const sourceNode = getNode(sourceLabel);
    const targetNode = getNode(targetLabel);

    const edgeKey = sourceNode.id + "||" + targetNode.id;
    if (!edgeKeySet.has(edgeKey)) {
      edgeKeySet.add(edgeKey);

      // Add unique link for the graph
      links.push({
        source: sourceNode.id,
        target: targetNode.id,
        label: interactionLabel,
        type: interactionType
      });

      // Link: try IRI from labelToIri; if missing, use "#" as placeholder
      const iri = labelToIri.get(sourceLabel) || "#";

      // Add corresponding row for the table
      tableRows.push({
        source: sourceNode.label,
        target: targetNode.label,
        url: iri,
        sourceId: sourceNode.id,
        targetId: targetNode.id
      });
    }
  }

  // Ensure every node has at least one row as SOURCE
  const nodesArray = Array.from(nodeMap.values());
  const hasSourceRow = new Set(tableRows.map(r => r.sourceId));

  nodesArray.forEach(node => {
    if (!hasSourceRow.has(node.id)) {
      // Node never appeared as a source: create a "node-only" row.
      const iri = labelToIri.get(node.label) || "#";
      tableRows.push({
        source: node.label,
        target: "(no outgoing interaction)",
        url: iri,
        sourceId: node.id,
        targetId: ""
      });
    }
  });

  return {
    nodes: nodesArray,
    links: links,
    tableRows: tableRows
  };
}



// =====================================================
//  CLEAR SVG
// =====================================================

function clearGraph() {
  svg.selectAll("*").remove();
}



// =====================================================
//  DRAW GRAPH WITH D3
// =====================================================

function drawGraph(graph) {
  const nodes = graph.nodes;
  const links = graph.links;

  // Arrow head for edges
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

  // Links
  const link = svg.append("g")
    .attr("class", "links")
    .selectAll("line")
    .data(links)
    .enter()
    .append("line")
    .attr("class", "link");

  // Nodes
  const node = svg.append("g")
    .attr("class", "nodes")
    .selectAll("g")
    .data(nodes)
    .enter()
    .append("g")
    .attr("class", "node");

  node.append("circle")
    .attr("r", 15);

  // Show the chosen human-readable label
  node.append("text")
    .attr("x", 18)
    .attr("y", 3)
    .text(d => d.label);

  // Tooltip on links
  link.append("title")
    .text(d => (d.label || "Interaction") + (d.type ? (" (" + d.type + ")") : ""));

  // On click: highlight corresponding source row in the table
  node.on("click", (event, d) => {
    highlightRowsForNode(d.id);
  });

  // Force simulation
  const simulation = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id(d => d.id).distance(120))
    .force("charge", d3.forceManyBody().strength(-200))
    .force("center", d3.forceCenter(width / 2, height / 2));

  const margin = 30; // margin so nodes stay inside the SVG

  simulation.on("tick", () => {
    // Keep nodes inside the visible area
    nodes.forEach(d => {
      d.x = Math.max(margin, Math.min(width - margin, d.x));
      d.y = Math.max(margin, Math.min(height - margin, d.y));
    });

    link
      .attr("x1", d => d.source.x)
      .attr("y1", d => d.source.y)
      .attr("x2", d => d.target.x)
      .attr("y2", d => d.target.y);

    node
      .attr("transform", d => `translate(${d.x},${d.y})`);
  });

  // Drag nodes with the mouse
  node.call(
    d3.drag()
      .on("start", (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on("end", (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      })
  );
}
