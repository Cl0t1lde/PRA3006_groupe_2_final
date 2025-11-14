document.addEventListener("DOMContentLoaded", () => {

  const dropdown = document.getElementById('Pathway');

  dropdown.addEventListener('change', function() {
    const selectedPathway = dropdown.value;
    console.log("Selected:", selectedPathway);
    updateQuery(selectedPathway);
    runEverything();
  });

});

// script.js
const endpointUrl = 'https://sparql.wikipathways.org/sparql/'; // defines Query Endpoint

var results
// Code for Query
var query = `
PREFIX wp: <http://vocabularies.wikipathways.org/wp#>
PREFIX dcterms: <http://purl.org/dc/terms/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT DISTINCT ?sourceLabel ?targetLabel ?interactionLabel ?interactionType
WHERE {
  ?pathway a wp:Pathway ;
           dcterms:identifier "WP3855" .

  ?interaction a wp:Interaction ;
               dcterms:isPartOf ?pathway ;
               wp:source ?source ;
               wp:target ?target .

  ?source rdfs:label ?sourceLabel .
  ?target rdfs:label ?targetLabel .
}
`;

function updateQuery(pathway) {
  query = `
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
console.log("Query:", pathway);
}

//define funtion to run Query
async function runQuery() { //async allows us to wait (await)
  const url = endpointUrl + '?query=' + encodeURIComponent(query); // defines request URL using the endpoint + Query code
  // Waits for server to respond before saving as a constant
  const response = await fetch(url, {
    headers: { 'Accept': 'application/sparql-results+json' }
  });
  // gets data as json from response?
  const data = await response.json();
  results = data.results.bindings; // gets results from the data (bindings -> one row)
}
 
function createTable() {
  const tableBody = document.getElementById("results"); //Gets the table of our html
  
  tableBody.innerHTML = "";
  results.forEach(row => { // For each row of our table:
    const tr = document.createElement("tr"); //Creates a constant holding new row in the websites table
    //defines the collumns
    tr.innerHTML = `
      <td>${row.sourceLabel.value}</td>
      <td>${row.targetLabel.value}</td>
    `;
    tableBody.appendChild(tr);// creates the row in the HTML with the constant tr
  });
  console.log(tableBody);
  console.log("HELLO");
}

function createNetwork() {
  // Create node and edge arrays for the vis-network
  const nodesSet = new Set();
  const edges = [];

  results.forEach(row => {
    const source = row.sourceLabel.value;
    const target = row.targetLabel.value;
    nodesSet.add(source);
    nodesSet.add(target);
    edges.push({ from: source, to: target });
  });

  const nodes = Array.from(nodesSet).map(label => ({ id: label, label }));

  // Display the network
  const container = document.getElementById('network');
  const dataVis = { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) };
  const options = {
    layout: { hierarchical: { direction: "UD", sortMethod: "directed" } },
    edges: { arrows: 'to', color: { color: '#0077cc' } },
    nodes: {
      shape: 'box',
      color: { background: '#e7f0ff', border: '#0077cc' },
      font: { color: '#333' }
    },
    physics: false
  };

  new vis.Network(container, dataVis, options);
}

async function runEverything() {
  await runQuery();
  createTable();
  createNetwork();
}
// Run function that runs the Query and sends data to html
runEverything();
