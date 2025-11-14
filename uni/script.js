document.addEventListener("DOMContentLoaded", () => {
  const dropdown = document.getElementById('Pathway');
  dropdown.addEventListener('change', () => {
    const pathway = dropdown.value;
    if (pathway) runEverything(pathway);
  });
});

const endpointUrl = 'https://sparql.wikipathways.org/sparql/';
var results
let geneResults = []; // store results of the gene query


// Generate SPARQL query for a given pathway
const getQuery = (pathway) => `
PREFIX wp: <http://vocabularies.wikipathways.org/wp#>
PREFIX dcterms: <http://purl.org/dc/terms/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT DISTINCT ?sourceLabel ?targetLabel ?interactionLabel ?interactionType
WHERE {
  ?pathway a wp:Pathway ;
           dcterms:identifier "${pathway}" .

  ?interaction a wp:Interaction ;
               dcterms:isPartOf ?pathway ;
               wp:source ?source ;
               wp:target ?target .

  ?source rdfs:label ?sourceLabel .
  ?target rdfs:label ?targetLabel .
}
`;

const getGeneQuery = (pathwayId) => `
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


// Fetch SPARQL results
async function runQuery(pathway) {
  try {
    const url = endpointUrl + '?query=' + encodeURIComponent(getQuery(pathway));
    const res = await fetch(url, { headers: { Accept: 'application/sparql-results+json' } });
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    results = data.results.bindings || [];
    console.log("SPARQL results:", results);
  } catch (err) {
    console.error("Query failed:", err);
    results = [];
  }
}

async function runGeneQuery(pathwayId) {
  try {
    const url = endpointUrl + '?query=' + encodeURIComponent(getGeneQuery(pathwayId));
    const res = await fetch(url, { headers: { Accept: 'application/sparql-results+json' } });
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    geneResults = data.results.bindings || [];
  } catch (err) {
    console.error("Gene query failed:", err);
    geneResults = [];
  }
}

// Populate table
function createTable() {
  const tbody = document.getElementById("results");
  tbody.innerHTML = results.length
    ? results.map(r => `<tr><td>${r.sourceLabel.value}</td><td>${r.targetLabel.value}</td></tr>`).join('')
    : "<tr><td colspan='2'>No data found</td></tr>";
}

function createGeneTable() {
  const tbody = document.getElementById("gene-results");
  tbody.innerHTML = geneResults.length
    ? geneResults.map(r => {
        const geneId = r.geneProduct.value; // full URI of gene product
        const label = r.geneProductLabel.value;
        return `
          <tr>
            <td><a href="${geneId}" target="_blank">${geneId}</a></td>
            <td>${label}</td>
          </tr>`;
      }).join('')
    : "<tr><td colspan='2'>No data found</td></tr>";
}



// Create network visualization
function createNetwork() {
  const container = document.getElementById('network');
  container.innerHTML = ""; // clear previous network
  if (!results.length) return;

  const nodesSet = new Set();
  const edges = [];

  results.forEach(r => {
    nodesSet.add(r.sourceLabel.value);
    nodesSet.add(r.targetLabel.value);
    edges.push({ from: r.sourceLabel.value, to: r.targetLabel.value });
  });

  const nodes = Array.from(nodesSet).map(label => ({ id: label, label }));
  new vis.Network(container, { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) }, {
    layout: { hierarchical: { direction: "UD", sortMethod: "directed" } },
    edges: { arrows: 'to', color: { color: '#0077cc' } },
    nodes: { shape: 'box', color: { background: '#e7f0ff', border: '#0077cc' }, font: { color: '#333' } },
    physics: false
  });
}

async function runEverything(pathwayId) {
  await runQuery(pathwayId);       // original table/network
  await runGeneQuery("WP17");      // gene product table (hard-coded to WP17)
  createTable();                   // original table
  createNetwork();                 // original network
  createGeneTable();               // gene product table
}
