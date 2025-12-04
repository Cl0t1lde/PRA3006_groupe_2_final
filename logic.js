const endpoint = "https://sparql.wikipathways.org/sparql";

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
//  DEDUPLICATION 
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
      canonicalLabel.set(src, src); // fallback: use uri if no srcLabel is defined
    }
    srcLabel = canonicalLabel.get(src); // assign srclabel to the consistent labels from canonicalLabel

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
    if (seenEdges.has(edgeKey)) return; // check if pair ID is not yet in the list, if it is skip
    seenEdges.add(edgeKey); //add the iD to the list 
    result.push({ // Add a cleaned, deduplicated version of the row to the results
      ...inter,
      sourceLabel: { value: srcLabel },
      targetLabel: { value: tgtLabel }
    });// Recreate a new interaction with canonical labels
  });

  return result;
}


// =====================================================
//  SPARQL QUERY 
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
//  CONVERT RAW ROWS → GRAPH
// =====================================================
function convertToGraph(rows, labelToIri) {
  const nodeMap = new Map();
  const links = [];
  const tableRows = [];
  const edgeSet = new Set();

  const currentPathway = pathwaySelect.value || "UNKNOWN";


  function getNode(label) { // Ensure each label corresponds to a unique node object in nodeMap
    const key = label.trim().toLowerCase().replace(/[^\w\s]|_/g, "").replace(/\s+/g, " "); //trim the label and put it in lowercase to normalise it in some way.
    let node = nodeMap.get(key); //look for the node associeted to that key in the map
  
    if (!node) { //if no node for that key yet
      node = { id: key, label: label }; // create a new node object with normalized id and original label
      nodeMap.set(key, node); // Store the new node object in nodeMap for future lookups

    }
  
    return node;
  }
  

  rows.forEach(r => {
    if (!r.sourceLabel || !r.targetLabel) return; // only process rows that have both source and target

    const sourceLabel = r.sourceLabel.value || ""; //fetch source and target in each row 
    const targetLabel = r.targetLabel.value || "";

    const sNode = getNode(sourceLabel);//apply the small normalisation logic
    const tNode = getNode(targetLabel);

    // Update global frequency only if this pathway hasn't been counted yet
    if (!loadedPathways.has(currentPathway)) { //if this pathway is not counted yet 
      if (!globalFreq.has(sNode.id)) globalFreq.set(sNode.id, { count: 0, pathways: new Set() });//if the node is not in the frequency map yet, add it with a counter and a set for pathways 
      if (!globalFreq.has(tNode.id)) globalFreq.set(tNode.id, { count: 0, pathways: new Set() });

      globalFreq.get(sNode.id).pathways.add(currentPathway);// update the pathway set with the current patway the node is in
      globalFreq.get(tNode.id).pathways.add(currentPathway);

      globalFreq.get(sNode.id).count = globalFreq.get(sNode.id).pathways.size; //count the amount of pathways a node is in and store it in count.
      globalFreq.get(tNode.id).count = globalFreq.get(tNode.id).pathways.size;
    }


    const key = sNode.id + "||" + tNode.id; //create a string with a source and target (edge between 2 nodes)
    if (edgeSet.has(key)) return; //add the edge to the edgeset if not in there yet (avoid duplicates)
    edgeSet.add(key);

    links.push({//add in an array, all the edges (non-duplicate) usefull for D3
      source: sNode.id,
      target: tNode.id,
      label: r.interactionLabel ? r.interactionLabel.value : "",
      type: r.interactionType ? r.interactionType.value : ""
    });

    const iri = labelToIri.get(sNode.label) || "#"; //fetch the URL of the source node from the url list
    tableRows.push({ //create an array with the content of the row in the future table
      source: sNode.label,
      target: tNode.label,
      url: iri,
      sourceId: sNode.id,
      targetId: tNode.id
    });
  });

  const nodes = Array.from(nodeMap.values()); //convert the map to an array
  const hasSource = new Set(tableRows.map(r => r.sourceId));//extract all the sources from the Tablerows to put them in a set

  //ensure nodes that don't have a target are also in the table.
  nodes.forEach(n => {//for each node in node array
    if (!hasSource.has(n.id)) {//if the node is not part of the source set (lonely node)
      const iri = labelToIri.get(n.label) || "#"; //look up the url for that node
      tableRows.push({//create a table row for that node 
        source: n.label,
        target: "(no outgoing interaction)",
        url: iri,
        sourceId: n.id,
        targetId: ""
      });

      // update frequency counting for lonely node 
      if (!loadedPathways.has(currentPathway)) {//if this pathway is not counted yet 
        if (!globalFreq.has(n.id)) globalFreq.set(n.id, { count: 0, pathways: new Set() });//if the node is not in the frequency map yet, add it with a counter and a set for pathways 
        globalFreq.get(n.id).pathways.add(currentPathway);// update the pathway set with the current patway the node is in
        globalFreq.get(n.id).count = globalFreq.get(n.id).pathways.size;//count the amount of pathways a node is in and store it in count.
      }

    }
  });

  return { nodes, links, tableRows};  
}

// =====================================================
//  TABLE HANDLING
// =====================================================
function clearTable() {
  const tbody = document.getElementById("resultsBody"); //Get the table body element from the HTML
  if (tbody) tbody.innerHTML = ""; //if found clear the table
}

function fillTableFromGraph(tableRows) { // Fills the HTML results table using the graph-derived rows
  const tbody = document.getElementById("resultsBody");
  if (!tbody) return; // No table body found → nothing to update

  // =====================================================
  // 1. Loop through each row of processed graph data
  // =====================================================
  tableRows.forEach(row => {
    const tr = document.createElement("tr"); // create new table row

    // store IDs on the <tr> as dataset attributes (useful for click handlers)
    tr.dataset.sourceId = row.sourceId;
    tr.dataset.targetId = row.targetId;

    // =====================================================
    // 2. Build the URL cell
    // Groups may have multiple URIs → row.url becomes an array
    // Single nodes → row.url is a string
    // =====================================================
    let urlCell = "";

    // Case 1: multiple URLs (array)
    if (Array.isArray(row.url)) {
      for (const u of row.url) {
        urlCell += `<a href="${u}" target="_blank" rel="noopener noreferrer">Link to source</a><br>`;
      }
    }

    // Case 2: single URL (string)
    else {
      urlCell = `<a href="${row.url}" target="_blank" rel="noopener noreferrer">Link to source</a>`;
    }

    // =====================================================
    // 3. Insert row content into the table
    // =====================================================
    tr.innerHTML = `
      <td>${row.source}</td>   <!-- Display source label -->
      <td>${row.target}</td>   <!-- Display target label -->
      <td>${urlCell}</td>      <!-- Display the URL(s), formatted above -->
    `;

    // Add the newly created row to the table
    tbody.appendChild(tr);
  });
}

function highlightRowsForNode(nodeId) {
  const tbody = document.getElementById("resultsBody"); //Get the table body from the HTML
  if (!tbody) return; //if table not found stop the code 

  tbody.querySelectorAll("tr").forEach(tr => { //select all the table rows and loop trough them.
    tr.classList.remove("highlight"); //first remove any potential previous highlight 
    if (tr.dataset.sourceId === nodeId) { //check if the sourceID in the atribute correspond to the clicked node.
      tr.classList.add("highlight"); //highlight the row if it match (add the "highlight class"
    }
  });
}

// =====================================================
//  GRAPH DRAWING – hierarchical layout (longest-path style)
// =====================================================
function clearGraph() {//clear the graph
  svg.selectAll("*").remove();
}

function shiftedTarget(d, offset) {//make sure the arrow stop at the node boundary (d: edge with position x and y, offset: radius of node)
  const dx = d.target.x - d.source.x; //dx of the arrow
  const dy = d.target.y - d.source.y; //dy of the arrow
  const len = Math.sqrt(dx * dx + dy * dy) || 1; //length of the vector
  return {
    x: d.target.x - (dx / len) * offset, //substract a vector with the radius length (in the direction of the arrow) to the arrow 
    y: d.target.y - (dy / len) * offset // this shift the target back along the edge by offset
  };
}

function drawGraph(graph) {
  const nodes = graph.nodes;//use output from convert to graph extract the nodes and the edges
  const rawLinks = graph.links;

  if (!nodes || nodes.length === 0) {
    statusEl.textContent = " No interactions found for this pathway.";
    return;
  }//safety measure if no node found 

  // links expressed as ids (so we can do graph algorithms)
  const edges = rawLinks.map(l => ({//create a new object for each link
    sourceId: typeof l.source === "string" ? l.source : l.source.id, //check if source is a string if yes keep this otherwise use the node ID
    targetId: typeof l.target === "string" ? l.target : l.target.id,
    label: l.label, //keep the labels
    type: l.type
  }));

  const nodesById = new Map(nodes.map(n => [n.id, n])); //create a map from the node array

  // assign actual node objects to edges for D3
  edges.forEach(e => {
    e.source = nodesById.get(e.sourceId);//replace the ID with actual node object from the map 
    e.target = nodesById.get(e.targetId);
  });

  clearGraph(); // remove old elements

  // --- arrow marker ---
  svg.append("defs")
    .append("marker") //marker for the arrow
    .attr("id", "arrow") //give it a name so we can reference it 
    .attr("viewBox", "0 0 10 10") //coordinate system fro the arrow
    .attr("refX", 10)
    .attr("refY", 5) //the placement of the trangle compare to the line
    .attr("markerWidth", 10)
    .attr("markerHeight", 10)//it's size
    .attr("orient", "auto")
    .append("path")
    .attr("d", "M 0 0 L 10 5 L 0 10 z")//draw the triangle (the arrow tip)
    .attr("fill", "#555");//give it a color 

  // --- force simulation ---
  const simulation = d3.forceSimulation(nodes) //create a force simulation to help with the mouvement of nodes
    .force("link", d3.forceLink(edges).id(d => d.id).distance(100)) //add a force link to the edges (For each node d, use its id property to match edges to nodes) also defined the distance between nodes
    .force("charge", d3.forceManyBody().strength(-100)) //add the type of the force here repulsive charge 
    .force("center", d3.forceCenter(width / 2, height / 2)) //center of the force in the middle 
    .force("collision", d3.forceCollide().radius(10)); //minimum distance between nodes, allow bounce interaction

  // --- links ---
  const link = svg.append("g") //add group for all the link lines
    .attr("class", "links") //add a class on the whole group for css styling
    .selectAll("line") // Prepare to bind data to <line> elements (none exist yet)
    .data(edges) // Bind the array of edge objects to future line elements
    .enter() // For each data item without a corresponding DOM element, create one
    .append("line") // Append a <line> element for each edge
    .attr("class", "link") //add a class for each individual link for css
    .attr("marker-end", "url(#arrow)"); //attach the arrowhead marker to the end of each link

  // --- nodes ---
  const node = svg.append("g") // Create a group to hold all nodes
    .attr("class", "nodes") // Add a class for styling or batch selection
    .selectAll("g") // Start a virtual selection (no <g> elements exist yet)
    .data(nodes) // Bind the nodes data to future node groups
    .enter() // Create DOM elements for each data item with no match
    .append("g") // Each node is a <g> container (for circle + text together)
    .attr("class", "node") // Each node is a <g> container (for circle + text together)
    .call(d3.drag() // Enable dragging behavior on each node
      .on("start", (event, d) => { // Fired when dragging starts (user clicked and is dragging the node)
        if (!event.active) simulation.alphaTarget(0.3).restart(); //wake up the physics 
        d.fx = d.x;
        d.fy = d.y;//fix the node position to follow the mouse and not the physic
      })
      .on("drag", (event, d) => {
        d.fx = event.x;
        d.fy = event.y; //follow the mouse position 
      })
      .on("end", (event, d) => {
        if (!event.active) simulation.alphaTarget(0); //tell the force simulation to cool down, let the graph settle
        d.fx = null;
        d.fy = null;//node not captured by the mous anymore free to move with the physics
      })
    );

  node.append("circle")
    .attr("r", 10); //defined the shape of the node

  node.append("text") //add the label of the node
    .attr("x", 12)
    .attr("y", 3)
    .text(d => d.label);

  link.append("title")
    .text(d => (d.label || "Interaction") + (d.type ? ` (${d.type})` : ""));//if any interaction, add the type of interaction when you hover over the line

  node.on("click", (e, d) => highlightRowsForNode(d.id)); //on clic use the function to highlight the row of the source

  simulation.on("tick", () => {//apply the physics simulation
    link
      .attr("x1", d => d.source.x)
      .attr("y1", d => d.source.y)
      .attr("x2", d => d.target.x)
      .attr("y2", d => d.target.y); //move the line to follow the node positions (initial to final)

    node.attr("transform", d => `translate(${d.x},${d.y})`);//move the node to the position determined by the physics
  });
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

async function getGpmlAsBindings(pathwayId, revision=0) { //Gets PathwayID -> returns GPML data as XML
  // =====================================================
  // 1. Fetch JSON that contains the GPML inside data.pathway.gpml
  // =====================================================

  // define link to Json
  const jsonURL = `https://webservice.wikipathways.org/getPathway?pwId=${pathwayId}&format=json&revision=${revision}`;
  // wait to fetch json + then save it as JSON
  const json = await fetch(jsonURL).then(r => r.json());
  const gpmlText = json.pathway.gpml; // Gets from JSON -> gpml data as txt
  // if (!gpmlText) throw new Error("GPML not found in JSON response"); //Debugging Line

  // =====================================================
  // 2. Clean namespaces so DOMParser can read it simply
  // =====================================================
  const cleanedXml = gpmlText
    .replace(/xmlns(:\w+)?="[^"]+"/g, "")    // remove xmlns and xmlns:gpml
    .replace(/gpml:/g, "");                 // remove gpml: prefixes

  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(cleanedXml, "application/xml"); // saves GPML data as an actual XML line

  return xmlDoc
}


function extractDataNodes(xmlDoc) {                       // Takes an XML document and pulls info from all <DataNode> elements
  const nodeEls = xmlDoc.getElementsByTagName("DataNode"); // All <DataNode> elements in the XML
  const nodeMap = {};                                      // Object where we store node info, keyed by ID
  let autoIdCounter = 0;                                   // Counter to create IDs when a node has none

  for (let i = 0; i < nodeEls.length; i++) {               // Go through each DataNode one by one
    const el = nodeEls[i];                                 // The current DataNode element
    let id = el.getAttribute("GraphId");                   // Try to read its "GraphId" attribute

    if (!id) {                                             // If there is no GraphId
      id = `auto_${autoIdCounter}`;                        // Make up an ID like "auto_0", "auto_1", ...
      autoIdCounter += 1;                                  // Increase the counter for the next one
    }

    const label = el.getAttribute("TextLabel") || id;      // Use "TextLabel" as display name, or fall back to id
    const type = el.getAttribute("Type") || "DataNode";    // Use "Type" if present, otherwise "DataNode"
    const groupRef = el.getAttribute("GroupRef") || null;  // Group reference if present, otherwise null
    console.log(groupRef, " + ", label, " + ", id);        // Log some info to the console for debugging

    let uri = null;                                        // Start with no external link (URI) yet
    const xref = el.getElementsByTagName("Xref")[0];       // Look for the first <Xref> child element

    if (xref) {                                            // If an <Xref> exists
      const db = (xref.getAttribute("Database") || "")     // Read "Database" name (e.g. uniprot)
        .toLowerCase();                                    // Make it lowercase for consistency
      const entry = xref.getAttribute("ID");               // Read the database entry ID

      if (db && entry) {                                   // Only if we have both a database and an ID
        uri = `https://identifiers.org/${db}/${entry}`;    // Build a full URL like https://identifiers.org/db/ID
      }
    }

    nodeMap[id] = { id, label, uri, type, groupRef };      // Store all collected info under this node’s ID
  }

  return nodeMap;                                          // Give back the object with all nodes and their info
}

function buildGroupsFromNodes(nodeMap, xmlDoc) { // Gets map of all nodes -> returns list of all groups
  const groups = {}; // groupId -> { id, members: [nodeIds], labels: [labels] }

  // =====================================================
  // 1. for each node in node map - if it has group Ref -> creates a group
  // =====================================================
  Object.values(nodeMap).forEach(node => {
    if (!node.groupRef) return; // No group ref -> skip
    const gid = node.groupRef; // else sets gid = groupRef
    if (!groups[gid]) groups[gid] = { id: gid, members: [], label: [], uris: [] }; // if GroupRef (gid) is new creates gid{id,members,labels}
    groups[gid].members.push(node.id); // In all cases (has groupRef) ->adds node id to members list of group
    groups[gid].uris.push(node.uri);
    groups[gid].label.push(node.label); // And adds the label to label list of group
  });

  // =====================================================
  // 2. Change the groupID to its Graph ID
  // All interactions are based onthe GraphID
  // GroupID is just used to define the group
  // =====================================================

  // checks for group section in the GPML ( group Z : {group ID: X} {GraphID: Y})
  xmlDoc.querySelectorAll("Group").forEach(g => {
    const groupId = g.getAttribute("GroupId");
    const graphId = g.getAttribute("GraphId");

    // Only adjust if:
    // - GroupID is found in the nodes as GroupRef
    // - AND graphId exists
    // - AND groupId != graphId
    if (groups[groupId] && graphId && graphId !== groupId) {
      groups[groupId].id = graphId;   // <- Replace GroupID with graphId
    }
  });

  // =====================================================
  // 3. creates labels for group (AKT1) (AKT2) -> (AKT1 / AKT2)
  // =====================================================

  Object.values(groups).forEach(g => {
    g.label = g.label.join(" / ");
  });

  return groups;
}


function extractInteractions(xmlDoc) { //Gets GPML XML Data -> returns (interactionID, pointRef(Source, Target), InteractionType)

  // =====================================================
  // 1. Define Variables and constants
  // =====================================================
  const interactionEls = xmlDoc.getElementsByTagName("Interaction");    // All <Interaction> elements in the XML
  const interactions = [];                                              // Array where we will store interaction info

  // =====================================================
  // 2. for each Interaction -> get GraphID, and pointEls (point: {source, target})
  // =====================================================
  for (let i = 0; i < interactionEls.length; i++) {                     // Go through each Interaction one by one
    const ie = interactionEls[i];                                       // Current Interaction element
    const interId = ie.getAttribute("GraphId") || `interaction_${i}`;   // Use its GraphId, or make one like "interaction_0"
    const pointEls = ie.getElementsByTagName("Point");                  // All <Point> elements inside this interaction
    const pointRefs = [];                                               // Will hold references to nodes this interaction touches
    const arrowHeads = [];                                              // Will hold arrow shapes/directions for each point

  // =====================================================
  // 3. for each (point: {source, target}) -> get ID and arrowHeads ("Arrow" or "Tbar") of target and source
  // =====================================================
    for (let p = 0; p < pointEls.length; p++) {                         // Loop through each Point in this interaction
      const pe = pointEls[p];                                           // Current Point element
      pointRefs.push(pe.getAttribute("GraphRef") || null);              // Save which node this point is connected to (or null)
      arrowHeads.push(pe.getAttribute("ArrowHead") || null);            // Save arrow type at this point (or null)
    }

    interactions.push({ interactionId: interId, pointRefs, arrowHeads });// Store everything for this interaction in the array
  }

  return interactions;                                                  // Give back the list of all interactions
}

function collapseGroupsAndBuildBindings({
  nodeMap,
  groups,
  interactions,
  pathwayId,
  revision,
  pathwayTitle
}) { // Gets Everything from previous GPML functions and creates a binding-type data structure

  // =====================================================
  // 1. Restructure each Group to match the shape of a DataNode
  // =====================================================
  Object.values(groups).forEach(g => {
    const uri = ``; // could be filled or follow identifiers.org pattern
    groups[g.id] = {
      id: g.id,
      uri: g.uris,          // uniform URI field for both nodes + groups
      label: g.label,
      members: g.members,
      type: "Group" // explicitly mark these as Group-type entries
    };
  });

  // =====================================================
  // 2. Helper: resolves a reference ID into either a node or a group
  // =====================================================
  function resolveRef(ref) {
    if (!ref) return null;            // ref missing → no source/target
    if (nodeMap[ref]) return nodeMap[ref];  // matches a node GraphId
    if (groups[ref]) return groups[ref];    // matches a group GraphId
    return null;                      // unknown → skip
  }

  const bindings = [];

  // =====================================================
  // 3. Build source/target bindings from GPML interactions
  // =====================================================
  interactions.forEach(inter => {
    const pts = inter.pointRefs.filter(Boolean); // remove null entries
    if (pts.length < 2) return; // interaction missing endpoints → skip

    // Default: first ref = source, second ref = target
    let sourceRef = pts[0];
    let targetRef = pts[1];

    // -----------------------------------------------------
    // 3A. If a node belongs to a group → replace nodeRef with groupId
    // -----------------------------------------------------
    if (nodeMap[sourceRef]?.groupRef && groups[nodeMap[sourceRef].groupRef]) {
      sourceRef = groups[nodeMap[sourceRef].groupRef].id; // use Group GraphId
    }

    if (nodeMap[targetRef]?.groupRef && groups[nodeMap[targetRef].groupRef]) {
      targetRef = groups[nodeMap[targetRef].groupRef].id;
    }

    // Resolve to actual node/group objects
    const source = resolveRef(sourceRef);
    const target = resolveRef(targetRef);

    if (!source || !target) return; // unresolved → skip interaction

    // =====================================================
    // 4. Pick URIs (fallback to id if no uri found)
    // =====================================================
    const sourceUri = source.uri || source.uri === null ? source.uri : source.id;
    const targetUri = target.uri || target.uri === null ? target.uri : target.id;

    // =====================================================
    // 5. Build SPARQL-style binding object
    // =====================================================
    const binding = {
      interaction: {
        type: "uri",
        value: `http://rdf.wikipathways.org/Pathway/${pathwayId}_r${revision}/WP/Interaction/${inter.interactionId}`
      },

      pathwayTitle: { 
        type: "literal",
        "xml:lang": "en",
        value: pathwayTitle 
      },

      // ----- Source -----
      source:      { type: "uri",     value: sourceUri || source.id },
      sourceLabel: { type: "literal", value: source.label },
      sourceType:  { type: "uri",     value: source.type },

      // ----- Target -----
      target:      { type: "uri",     value: targetUri || target.id },
      targetLabel: { type: "literal", value: target.label },
      targetType:  { type: "uri",     value: target.type }
    };

    bindings.push(binding);
  });

  // =====================================================
  // 6. Return SPARQL-like structure containing bindings
  // =====================================================
  return {
    head: {
      link: [],
      vars: [
        "interaction",
        "interactionType",
        "pathwayTitle",
        "source",
        "sourceLabel",
        "sourceType",
        "sourceGroup",
        "sourceMembers",
        "target",
        "targetLabel",
        "targetType",
        "targetGroup",
        "targetMembers"
      ]
    },
    results: { bindings }
  };
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
    ////////////////////////////////
    //  1. Fetch Query Results    //
    ////////////////////////////////
    const headers = { Accept: "application/sparql-results+json" };
    const query = getQuery(pathwayId);

    const res = await fetch(endpoint + "?query=" + encodeURIComponent(query), { headers });
    if (!res.ok) throw new Error("HTTP " + res.status);

    const json = await res.json();
    pathwayTitle.textContent = json.results.bindings?.[0]?.pathwayTitle?.value ?? "No title";

    ////////////////////////////////
    //  2. Fetch QPML Results     //
    ////////////////////////////////

    const xmlDoc = await getGpmlAsBindings(pathwayId);
    const nodeMap = extractDataNodes(xmlDoc);
    const groups = buildGroupsFromNodes(nodeMap, xmlDoc);
    const interactions = extractInteractions(xmlDoc);
    const sparqlStyle = collapseGroupsAndBuildBindings({
      nodeMap, groups, interactions,
      pathwayId: pathwayId, revision: "0",
      pathwayTitle: xmlDoc.documentElement.getAttribute("Name")
    });

    ////////////////////////////////
    //  3. Merge Sparql + GPML    //
    ////////////////////////////////

    const mergedBindings = [
        ...json.results.bindings,
        ...sparqlStyle.results.bindings
    ];
    json.results.bindings = mergedBindings;

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

    fillTableFromGraph(graph.tableRows);
    drawGraph(graph);
    statusEl.textContent = " Done.";
  } catch (e) {
    console.error(e);
    statusEl.textContent = " Error: " + e.message;
  }
}












