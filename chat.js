// =====================================================
//  LABEL NORMALISATION + MERGING
// =====================================================

// Optional manual aliases if you ever need them in the future.
const aliasMap = {
  // Example of usage if needed:
  // "PIP3": "PIP",
};

function basicNormalize(label) {
  return label.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function coreKeyFromLabel(label) {
  let core = label.split("/")[0];
  core = core.trim().toUpperCase();
  core = core.replace(/[^A-Z0-9]/g, "");
  if (aliasMap[core]) {
    core = aliasMap[core];
  }
  return core;
}

function chooseCanonicalKey(coreKey, existingKeys) {
  for (const existing of existingKeys) {
    const minLen = Math.min(existing.length, coreKey.length);
    if (
      minLen >= 3 &&
      (existing.startsWith(coreKey) || coreKey.startsWith(existing))
    ) {
      return existing;
    }
  }
  return coreKey;
}

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

  const extraCurrentDigitsOnly =
    extraCurrent !== "" && /^[0-9]+$/.test(extraCurrent);
  const extraNewDigitsOnly = extraNew !== "" && /^[0-9]+$/.test(extraNew);

  if (extraCurrent === "" && extraNewDigitsOnly) {
    return currentLabel; // PIP vs PIP3 -> keep PIP
  }
  if (extraNew === "" && extraCurrentDigitsOnly) {
    return newLabel; // PIP3 vs PIP -> keep PIP
  }

  return newLabel.length > currentLabel.length ? newLabel : currentLabel;
}



// =====================================================
//  SPARQL ENDPOINT + QUERY BUILDERS
// =====================================================

const endpoint = "https://sparql.wikipathways.org/sparql";

// Build interaction query for a given pathway ID
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

// Build link query (your query) for a given pathway ID
function buildLinkQuery(pathwayId) {
  return `
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
               dcterms:identifier "${pathwayId}" .

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
}



// =====================================================
//  HOOK INTO THE HTML
// =====================================================

const svg = d3.select("#graph");
const width = svg.node().clientWidth;
const height = svg.node().clientHeight;
const statusEl = document.getElementById("status");
const loadBtn = document.getElementById("loadBtn");
const pathwaySelect = document.getElementById("pathwaySelect");
const pathwayLabel = document.getElementById("pathwayLabel");

// reload button
loadBtn.addEventListener("click", () => run());

// change pathway when dropdown changes
pathwaySelect.addEventListener("change", () => run());

// initial run
run();



// =====================================================
//  MAIN: FETCH DATA + FILL TABLE + DRAW GRAPH
// =====================================================

async function run() {
  const pathwayId = pathwaySelect.value || "WP17";
  pathwayLabel.textContent = pathwayId;

  statusEl.textContent = " Loading data…";
  clearGraph();
  clearTable();

  try {
    const headers = { "Accept": "application/sparql-results+json" };

    const interactionQuery = buildInteractionQuery(pathwayId);
    const linkQuery = buildLinkQuery(pathwayId);

    // Fetch BOTH queries in parallel
    const [interRes, linkRes] = await Promise.all([
      fetch(endpoint + "?query=" + encodeURIComponent(interactionQuery), {
        headers,
      }),
      fetch(endpoint + "?query=" + encodeURIComponent(linkQuery), {
        headers,
      }),
    ]);

    if (!interRes.ok) throw new Error("Interaction HTTP " + interRes.status);
    if (!linkRes.ok) throw new Error("Link HTTP " + linkRes.status);

    const [interJson, linkJson] = await Promise.all([
      interRes.json(),
      linkRes.json(),
    ]);

    // Build label -> IRI map from link query
    const labelToIri = buildLabelToIriMap(linkJson);

    // Build merged nodes + unique edges + table rows from interaction query
    const graphData = convertToGraph(interJson.results.bindings, labelToIri);

    // Fill table and draw graph
    fillTableFromGraph(graphData.tableRows);
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

  rows.forEach((row) => {
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

  tableRows.forEach((row) => {
    const tr = document.createElement("tr");
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

function highlightRowsForNode(nodeId) {
  const tbody = document.getElementById("resultsBody");
  if (!tbody) return;

  const rows = tbody.querySelectorAll("tr");
  rows.forEach((tr) => {
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
  const nodeMap = new Map();
  const links = [];
  const tableRows = [];
  const edgeKeySet = new Set();

  function getNode(label) {
    const coreKey = coreKeyFromLabel(label);
    const existingKeys = Array.from(nodeMap.keys());
    const canonicalKey = chooseCanonicalKey(coreKey, existingKeys);

    let node = nodeMap.get(canonicalKey);
    if (!node) {
      node = { id: canonicalKey, label: label };
      nodeMap.set(canonicalKey, node);
    } else {
      node.label = chooseBetterLabel(node.label, label, coreKey);
    }
    return node;
  }

  for (const row of rows) {
    const sourceLabel = row.sourceLabel.value;
    const targetLabel = row.targetLabel.value;
    const interactionLabel = row.interactionLabel
      ? row.interactionLabel.value
      : "";
    const interactionType = row.interactionType
      ? row.interactionType.value
      : "";

    const sourceNode = getNode(sourceLabel);
    const targetNode = getNode(targetLabel);

    const edgeKey = sourceNode.id + "||" + targetNode.id;
    if (!edgeKeySet.has(edgeKey)) {
      edgeKeySet.add(edgeKey);

      links.push({
        source: sourceNode.id,
        target: targetNode.id,
        label: interactionLabel,
        type: interactionType,
      });

      const iri = labelToIri.get(sourceLabel) || "#";

      tableRows.push({
        source: sourceNode.label,
        target: targetNode.label,
        url: iri,
        sourceId: sourceNode.id,
        targetId: targetNode.id,
      });
    }
  }

  const nodesArray = Array.from(nodeMap.values());
  const hasSourceRow = new Set(tableRows.map((r) => r.sourceId));

  nodesArray.forEach((node) => {
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

  return {
    nodes: nodesArray,
    links: links,
    tableRows: tableRows,
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

  svg.selectAll("*").remove();

  svg
    .append("defs")
    .append("marker")
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

  const link = svg
    .append("g")
    .attr("class", "links")
    .selectAll("line")
    .data(links)
    .enter()
    .append("line")
    .attr("class", "link");

  const node = svg
    .append("g")
    .attr("class", "nodes")
    .selectAll("g")
    .data(nodes)
    .enter()
    .append("g")
    .attr("class", "node");

  node.append("circle").attr("r", 15);

  node
    .append("text")
    .attr("x", 18)
    .attr("y", 3)
    .text((d) => d.label);

  link
    .append("title")
    .text(
      (d) =>
        (d.label || "Interaction") +
        (d.type ? " (" + d.type + ")" : "")
    );

  node.on("click", (event, d) => {
    highlightRowsForNode(d.id);
  });

  const simulation = d3
    .forceSimulation(nodes)
    .force("link", d3.forceLink(links).id((d) => d.id).distance(120))
    .force("charge", d3.forceManyBody().strength(-200))
    .force("center", d3.forceCenter(width / 2, height / 2));

  const margin = 30;

  simulation.on("tick", () => {
    nodes.forEach((d) => {
      d.x = Math.max(margin, Math.min(width - margin, d.x));
      d.y = Math.max(margin, Math.min(height - margin, d.y));
    });

    link
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y);

    node.attr("transform", (d) => `translate(${d.x},${d.y})`);
  });

  node.call(
    d3
      .drag()
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
