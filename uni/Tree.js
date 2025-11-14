
async function runQuery() {
  const url = endpointUrl + '?query=' + encodeURIComponent(query);
  const response = await fetch(url, { headers: { 'Accept': 'application/sparql-results+json' } });
  const data = await response.json();

  const results = data.results.bindings;

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

runQuery();
