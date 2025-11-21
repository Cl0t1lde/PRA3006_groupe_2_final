document.addEventListener("DOMContentLoaded", () => {
  const dropdown = document.getElementById("Pathway");

  dropdown.addEventListener("change", () => {
    const pathway = dropdown.value;
    if (pathway) runEverything(pathway);
  });
});

// =====================================================
//  GLOBALS + ENDPOINT
// =====================================================

const endpointUrl = "https://sparql.wikipathways.org/sparql/";
let results;
let results2;
let geneResults = []; // store results of the gene query


// =====================================================
//  SPARQL QUERY GENERATOR
// =====================================================

const getQuery = (pathway) => `
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
           dcterms:identifier "${pathway}" .

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
//  FETCH SPARQL RESULTS
// =====================================================

async function runQuery(pathway) {
  try {
    const url =
      endpointUrl + "?query=" + encodeURIComponent(getQuery(pathway));

    const res = await fetch(url, {
      headers: { Accept: "application/sparql-results+json" },
    });

    if (!res.ok) throw new Error(res.statusText);

    const data = await res.json();
    results = data.results.bindings || [];

    console.log("SPARQL results:", results);

    results2 = removeDuplicateInteractions3(results);

    console.log("Filtered + Dup:", results2);
  } catch (err) {
    console.error("Query failed:", err);
    results = [];
  }
}


// =====================================================
//  FILTER / REMOVE UNWANTED ROWS (currently unused)
// =====================================================

function filterQuery(results) {
  return results.filter((row) => {
    const sourceType = row.sourceType?.value || "";
    const targetType = row.targetType?.value || "";
    const interactionType = row.interactionType?.value || "";

    if (
      sourceType.includes("DataNode") ||
      targetType.includes("DataNode") ||
      interactionType.includes("#Interaction")
    ) {
      return false;
    }
    return true;
  });
}


// =====================================================
//  DEDUPLICATION + LABEL NORMALISATION
// =====================================================

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



// =====================================================
//  TABLE POPULATION
// =====================================================

function createTable() {
  const tbody = document.getElementById("results");

  tbody.innerHTML = results2.length
    ? results2
        .map(
          (r) =>
            `<tr><td>${r.sourceLabel.value}</td><td>${r.targetLabel.value}</td></tr>`
        )
        .join("")
    : "<tr><td colspan='2'>No data found</td></tr>";
}


// =====================================================
//  NETWORK VISUALISATION (vis.js)
// =====================================================

function createNetwork() {
  const container = document.getElementById("network");
  container.innerHTML = ""; // clear previous network

  if (!results2.length) return;

  const nodesSet = new Set();
  const edges = [];

  results2.forEach((r) => {
    nodesSet.add(r.sourceLabel.value);
    nodesSet.add(r.targetLabel.value);

    edges.push({
      from: r.sourceLabel.value,
      to: r.targetLabel.value,
    });
  });

  const nodes = Array.from(nodesSet).map((label) => ({
    id: label,
    label,
  }));

  new vis.Network(
    container,
    {
      nodes: new vis.DataSet(nodes),
      edges: new vis.DataSet(edges),
    },
    {
      layout: {
        hierarchical: { direction: "UD", sortMethod: "directed" },
      },
      edges: { arrows: "to", color: { color: "#0077cc" } },
      nodes: {
        shape: "box",
        color: { background: "#e7f0ff", border: "#0077cc" },
        font: { color: "#333" },
      },
      physics: false,
    }
  );
}


// =====================================================
//  MAIN RUNNER
// =====================================================

async function runEverything(pathway) {
  await runQuery(pathway);
  createTable();
  createNetwork();
}

// Initial run
runEverything();
