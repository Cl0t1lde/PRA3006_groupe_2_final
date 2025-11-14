// script.js
const endpointUrl = 'https://sparql.wikipathways.org/sparql/'; // defines Query Endpoint

// Code for Query
const query = `
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

//define funtion to run Query
async function runQuery() { //async allows us to wait (await)
  const url = endpointUrl + '?query=' + encodeURIComponent(query); // defines request URL using the endpoint + Query code
  // Waits for server to respond before saving as a constant
  const response = await fetch(url, {
    headers: { 'Accept': 'application/sparql-results+json' }
  });
  // gets data as json from response?
  const data = await response.json();
  
  const results = data.results.bindings; // gets results from the data (bindings -> one row)
  const tableBody = document.getElementById("results"); //Gets the table of our html

  results.forEach(row => { // For each row of our table:
    const tr = document.createElement("tr"); //Creates a constant holding new row in the websites table
    //defines the collumns
    tr.innerHTML = `
      <td>${row.sourceLabel.value}</td>
      <td>${row.targetLabel.value}</td>
    `;
    tableBody.appendChild(tr);// creates the row in the HTML with the constant tr
  });
}

// Run function that runs the Query and sends data to html
runQuery();
