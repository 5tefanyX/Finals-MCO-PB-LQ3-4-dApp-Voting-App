const contractAddress = "0x6687a4fF56E9B24b0C7d37A8e074bc8c78834490";

const contractABI = [
  "function addCandidate(string name, string position)",
  "function authorizeVoter(address voter)",
  "function startElection()",
  "function endElection()",
  "function vote(uint256 candidateId)",
  // FIXED: the contract returns a struct, so the output must be a tuple
  "function getCandidate(uint256 candidateId) view returns (tuple(uint256 id, string name, string position, uint256 voteCount, bool exists))",
  "function getCandidateCount() view returns (uint256)",
  "function getTotalVotes() view returns (uint256)",
  "function getElectionStatus() view returns (bool)",
  // ADDED: used for admin login, voter status, and detecting a closed election
  "function owner() view returns (address)",
  "function authorizedVoters(address) view returns (bool)",
  "function hasVoted(address) view returns (bool)",
  "event ElectionStatusChanged(bool isOpen)"
];

let provider;
let signer;
let contract;
let userAccount;
let isAdmin = false; // ADDED

const $ = (id) => document.getElementById(id);
const page = document.body.dataset.page; // ADDED: "voter" or "admin"
const connectButton = $("connectButton");
const walletStatus = $("walletStatus");
const electionStatus = $("electionStatus");
const totalVotes = $("totalVotes");
const candidateList = $("candidateList");

const errMsg = (e) => (e && (e.reason || (e.error && e.error.message) || e.message)) || "Unknown error";
const esc = (t) => { const d = document.createElement("div"); d.textContent = t; return d.innerHTML; };
// ADDED: voter registrations are saved in the browser (localStorage)
const getRegs = () => { try { return JSON.parse(localStorage.getItem("registrations")) || {}; } catch (e) { return {}; } };

connectButton.addEventListener("click", connectWallet);
const on = (id, fn) => { if ($(id)) $(id).addEventListener("click", fn); };
on("addCandidateButton", addCandidate);
on("authorizeVoterButton", () => authorizeVoter($("voterAddress").value.trim()));
on("startElectionButton", startElection);
on("endElectionButton", endElection);
on("registerButton", registerVoter);
if (window.ethereum) { // reload when the MetaMask account changes
  window.ethereum.on("accountsChanged", () => location.reload());
  window.ethereum.on("chainChanged", () => location.reload());
}

async function connectWallet() {
  if (!window.ethereum) {
    walletStatus.innerText = "Please install MetaMask.";
    return;
  }
  try {
    provider = new ethers.providers.Web3Provider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    signer = provider.getSigner();
    userAccount = await signer.getAddress();
    contract = new ethers.Contract(contractAddress, contractABI, signer);
    // ADDED: the admin is the wallet that deployed the contract
    isAdmin = (await contract.owner()).toLowerCase() === userAccount.toLowerCase();
    walletStatus.innerText = "Connected: " + userAccount.slice(0, 6) + "..." + userAccount.slice(-4) + (isAdmin ? " (admin)" : "");
    loadElectionData();
  } catch (error) {
    alert("Could not connect: " + errMsg(error));
  }
}

// ADDED: voter registration request (name + student ID + wallet)
function registerVoter() {
  const name = $("regName").value.trim();
  const studentId = $("regId").value.trim();
  if (!name || !studentId) return alert("Enter your full name and student ID.");
  const regs = getRegs();
  regs[userAccount.toLowerCase()] = { address: userAccount, name, studentId };
  localStorage.setItem("registrations", JSON.stringify(regs));
  loadElectionData();
}

async function addCandidate() {
  const name = $("candidateName").value.trim();
  const position = $("candidatePosition").value.trim();
  if (!name) return alert("Enter the candidate name.");
  try {
    const tx = await contract.addCandidate(name, position);
    await tx.wait();
    $("candidateName").value = "";
    $("candidatePosition").value = "";
    loadElectionData();
  } catch (error) {
    alert("Add candidate failed: " + errMsg(error));
  }
}

async function authorizeVoter(voter) {
  if (!ethers.utils.isAddress(voter)) return alert("Enter a valid wallet address (0x...).");
  try {
    const tx = await contract.authorizeVoter(voter);
    await tx.wait();
    if ($("voterAddress")) $("voterAddress").value = "";
    loadElectionData();
  } catch (error) {
    alert("Authorize voter failed: " + errMsg(error));
  }
}

async function startElection() {
  try {
    const tx = await contract.startElection();
    await tx.wait();
    loadElectionData();
  } catch (error) {
    alert("Could not start election: " + errMsg(error));
  }
}

async function endElection() {
  try {
    const tx = await contract.endElection();
    await tx.wait();
    loadElectionData();
  } catch (error) {
    alert("Could not end election: " + errMsg(error));
  }
}

async function vote(candidateId) {
  try {
    const tx = await contract.vote(candidateId);
    await tx.wait();
    loadElectionData();
  } catch (error) {
    alert("Voting failed. You may not be authorized or may have already voted.\n\n" + errMsg(error));
  }
}

async function loadElectionData() {
  if (!contract) return;
  try {
    const isOpen = await contract.getElectionStatus();
    const count = (await contract.getCandidateCount()).toNumber();
    const votes = (await contract.getTotalVotes()).toNumber();

    // ADDED: "closed" alone can't tell "not started" from "finished",
    // so check whether a close event ever happened
    let ended = false;
    if (!isOpen) {
      try {
        const logs = await contract.queryFilter(contract.filters.ElectionStatusChanged(), 0);
        ended = logs.some((l) => !l.args.isOpen);
      } catch (e) { ended = votes > 0; }
    }

    electionStatus.innerText = isOpen ? "Voting is OPEN" : ended ? "Voting is CLOSED. Results are final." : "Voting has not started yet.";
    totalVotes.innerText = "Total votes: " + votes;

    const candidates = [];
    for (let i = 1; i <= count; i++) {
      const c = await contract.getCandidate(i);
      candidates.push({ id: c.id, name: c.name, position: c.position, votes: c.voteCount.toNumber() });
    }

    if (page.startsWith("admin")) await showAdmin(isOpen, candidates);
    else await showVoter(isOpen, candidates);

    // ADDED: results are shown only after the election is closed
    if ($("results")) $("results").innerHTML = ended ? resultsTable(candidates, votes) : '<p class="empty">Results appear after the admin closes voting.</p>';
  } catch (error) {
    alert("Could not load data: " + errMsg(error));
  }
}

function renderList(candidates, canVote) {
  candidateList.innerHTML = candidates.length ? "" : '<p class="empty">No candidates yet.</p>';
  candidates.forEach((c) => {
    const div = document.createElement("div");
    div.className = "candidate";
    div.innerHTML = "<strong>" + esc(c.name) + "</strong><br />" + esc(c.position);
    if (canVote) {
      const voteButton = document.createElement("button");
      voteButton.innerText = "Vote for " + c.name;
      voteButton.addEventListener("click", () => vote(c.id));
      div.appendChild(voteButton);
    }
    candidateList.appendChild(div);
  });
}

function resultsTable(candidates, votes) {
  const max = Math.max(0, ...candidates.map((c) => c.votes));
  const rows = candidates.map((c) =>
    "<tr><td>" + esc(c.name) + "</td><td>" + c.votes + "</td><td>" +
    (votes ? Math.round((c.votes * 100) / votes) : 0) + "%</td><td>" +
    (max > 0 && c.votes === max ? "Top" : "") + "</td></tr>").join("");
  return "<table><tr><th>Candidate</th><th>Votes</th><th>Share</th><th></th></tr>" + rows + "</table>";
}

// ADDED: voter view (registration status, vote buttons)
async function showVoter(isOpen, candidates) {
  const authorized = await contract.authorizedVoters(userAccount);
  const voted = await contract.hasVoted(userAccount);
  const reg = getRegs()[userAccount.toLowerCase()];
  $("app").hidden = false;
  $("adminLink").hidden = !isAdmin;
  if ($("registerCard")) $("registerCard").hidden = !!(reg || authorized) || isAdmin;
  if ($("voterStatus")) $("voterStatus").innerText = isAdmin ? "You are logged in as the Election Admin. Admins manage the election and do not vote. Use the Admin page."
    : voted ? "You have already voted. Thank you."
    : authorized ? (isOpen ? (page === "vote" ? "You are authorized. Choose a candidate below." : "You are authorized. Voting is open: go to the Vote page.") : "You are authorized. Voting is not open right now.")
    : reg ? "Registered. Waiting for the admin to authorize your wallet."
    : "Not registered yet. Register below to request access.";
  if (candidateList) renderList(candidates, page === "vote" && isOpen && authorized && !voted && !isAdmin);
}

// ADDED: admin view (only the contract owner), with pending registrations
async function showAdmin(isOpen, candidates) {
  $("denied").hidden = isAdmin;
  $("adminApp").hidden = !isAdmin;
  if (!isAdmin) return;
  ["startElectionButton", "addCandidateButton", "authorizeVoterButton"].forEach((id) => { if ($(id)) $(id).disabled = isOpen; });
  if ($("endElectionButton")) $("endElectionButton").disabled = !isOpen;
  if (candidateList) renderList(candidates, false);

  const box = $("registrations");
  if (!box) return;
  // the admin wallet is never listed as a voter
  const regs = Object.values(getRegs()).filter((r) => r.address.toLowerCase() !== userAccount.toLowerCase());
  box.innerHTML = regs.length ? "" : '<p class="empty">No registrations yet.</p>';
  for (const r of regs) {
    const ok = await contract.authorizedVoters(r.address);
    const row = document.createElement("div");
    row.className = "reg-row";
    row.innerHTML = "<span><strong>" + esc(r.name) + "</strong> (" + esc(r.studentId) + ")<br /><small>" +
      r.address.slice(0, 6) + "..." + r.address.slice(-4) + "</small></span>";
    if (ok) row.insertAdjacentHTML("beforeend", '<span class="tag">Authorized</span>');
    else {
      const b = document.createElement("button");
      b.innerText = "Authorize";
      b.disabled = isOpen;
      b.addEventListener("click", () => authorizeVoter(r.address));
      row.appendChild(b);
    }
    box.appendChild(row);
  }
}

// ADDED: stay logged in when moving between pages
(async () => {
  if (!window.ethereum) return;
  const accounts = await window.ethereum.request({ method: "eth_accounts" });
  if (accounts.length) connectWallet();
})();