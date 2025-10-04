// server.js - VERSÃO 100% COMPLETA E CORRIGIDA

const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const SteamUser = require('steam-user');

const app = express();
// const port = 3000;
const port = process.env.PORT || 3000;
app.use(express.json());

const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const SENTRY_DIR = path.join(__dirname, 'sentry');
const steamClients = {};
let accountsData = [];

function getGameDetails(appid) {
    return new Promise((resolve) => {
        https.get(`https://store.steampowered.com/api/appdetails?appids=${appid}`, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const defaultResponse = { name: `Jogo (${appid})`, headerImage: null };
                    if (json[appid] && json[appid].success) {
                        resolve({ name: json[appid].data.name, headerImage: json[appid].data.header_image });
                    } else { resolve(defaultResponse); }
                } catch (e) { resolve({ name: `Jogo (${appid})`, headerImage: null }); }
            });
        }).on('error', () => { resolve({ name: `Jogo (${appid})`, headerImage: null }); });
    });
}

async function startFarming(username, appids) {
    const clientData = steamClients[username];
    const account = accountsData.find(acc => acc.username === username);
    if (clientData && account && clientData.client.steamID) {
        clientData.client.setPersona(SteamUser.EPersonaState.Online);
        clientData.client.gamesPlayed(appids.map(id => ({ game_id: id })));
        clientData.isFarming = true;
        account.gamesBeingFarmed = await Promise.all(appids.map(id => getGameDetails(id)));
        console.log(`✅ '${username}' começando a farmar ${appids.length} jogo(s).`);
    }
}

function stopFarming(username) {
    const clientData = steamClients[username];
    const account = accountsData.find(acc => acc.username === username);
    if (clientData) {
        if (clientData.client.steamID) clientData.client.gamesPlayed([]);
        clientData.isFarming = false;
        if (account) delete account.gamesBeingFarmed;
        console.log(`Farm parado para '${username}'.`);
    }
}

function loginAccount(username, password = null, isInitialLogin = false) {
    const clientData = steamClients[username];
    if (!clientData || clientData.isLoggingIn) return;
    const account = accountsData.find(acc => acc.username === username);
    if (!account) return;
    const logOnOptions = { accountName: username };
    if (isInitialLogin && password) {
        logOnOptions.password = password;
        logOnOptions.rememberPassword = true;
    }
    if (account.loginKey) logOnOptions.logOnToken = account.loginKey;
    const sentryPath = account.sentry;
    if (sentryPath && fs.existsSync(sentryPath)) logOnOptions.sentry = fs.readFileSync(sentryPath);
    if (clientData.client.steamID) clientData.client.logOff();
    clientData.isLoggingIn = true;
    clientData.client.logOn(logOnOptions);
    console.log(`Tentando conectar '${username}'...`);
}

function setupSteamClientEvents(username, client) {
    client.on('error', (err) => {
        const clientData = steamClients[username];
        if (!clientData) return;
        let errorMsg = SteamUser.EResult[err.eresult] || `Código: ${err.eresult}`;
        console.log(`❌ Erro para '${username}': ${errorMsg}.`);
        const account = accountsData.find(acc => acc.username === username);

        if (err.eresult === SteamUser.EResult.InvalidPassword && account) {
            console.log(`-> Recebido InvalidPassword para ${username}. Limpando loginKey e sinalizando para relogin.`);
            account.loginKey = null;
            account.loginKeyInvalid = true; // NOVO SINALIZADOR
            savePersistentAccounts();
        }
        clientData.isLoggingIn = false;
        clientData.isFarming = false;
    });

    client.on('loggedOn', () => {
        const clientData = steamClients[username];
        const account = accountsData.find(acc => acc.username === username);
        if (clientData && account) {
            clientData.isLoggingIn = false;
            account.loginKeyInvalid = false; // Reseta o sinalizador em um login bem-sucedido
            savePersistentAccounts();
            console.log(`✅ '${username}' logado.`);
            if (clientData.isFarming) {
                startFarming(username, account.appids);
            }
        }
    });

    client.on('user', (sid, user) => {
        if (client.steamID && sid.getSteamID64() === client.steamID.getSteamID64()) {
            const account = accountsData.find(acc => acc.username === username);
            if (!account) return;
            account.avatarHash = user.avatar_hash ? user.avatar_hash.toString('hex') : null;
            account.profileName = user.player_name || null;
            savePersistentAccounts();
        }
    });

    client.on('steamGuard', (domain, callback) => {
        const clientData = steamClients[username];
        if (clientData) {
            clientData.steamGuardCallback = callback;
            clientData.isLoggingIn = false;
            console.log(`❗ Steam Guard solicitado para ${username}. Aguardando código via API.`);
        }
    });

    client.on('disconnected', () => { if (steamClients[username]) steamClients[username].isFarming = false; });
    
    client.on('loginKey', (key) => { 
        const acc = accountsData.find(a => a.username === username); 
        if (acc) { 
            acc.loginKey = key; 
            savePersistentAccounts(); 
        } 
    });
    
    client.on('sentry', (sentryHash) => {
        const acc = accountsData.find(a => a.username === username);
        if (acc) {
            const sentryPath = path.join(SENTRY_DIR, `${username}.bin`);
            fs.writeFileSync(sentryPath, sentryHash);
            acc.sentry = sentryPath;
            savePersistentAccounts();
        }
    });
}

function savePersistentAccounts() {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accountsData, null, 2), 'utf8');
}

function initializeClients() {
    accountsData.forEach(acc => {
        // Reseta o sinalizador ao iniciar o servidor, para permitir nova tentativa de login
        if (acc.loginKeyInvalid) acc.loginKeyInvalid = false;
        if (!steamClients[acc.username]) {
            const client = new SteamUser({ dataDirectory: null });
            steamClients[acc.username] = { client, steamGuardCallback: null, isFarming: false, isLoggingIn: false };
            setupSteamClientEvents(acc.username, client);
        }
    });
}

function loadPersistentAccounts() {
    if (fs.existsSync(ACCOUNTS_FILE)) {
        try { accountsData = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch { accountsData = []; }
    }
    initializeClients();
    console.log(`Carregando ${accountsData.length} conta(s) e tentando login automático...`);
    accountsData.forEach(acc => {
        loginAccount(acc.username);
    });
}

// ---- ROTAS DA API ----
app.get('/api/accounts', (req, res) => {
    const dataToSend = accountsData.map(acc => ({
        ...acc,
        isFarming: steamClients[acc.username]?.isFarming || false,
        isLoggingIn: steamClients[acc.username]?.isLoggingIn || false,
        needsSteamGuard: !!steamClients[acc.username]?.steamGuardCallback
    }));
    res.json(dataToSend);
});

app.post('/api/accounts', (req, res) => {
    const { username, password, displayName, appids } = req.body;
    if (accountsData.some(acc => acc.username === username)) {
        return res.status(409).json({ message: `Conta '${username}' já existe.` });
    }
    const newAccount = { username, displayName, appids, loginKey: null, sentry: null, avatarHash: null, profileName: null };
    accountsData.push(newAccount);
    savePersistentAccounts();
    initializeClients();
    loginAccount(username, password, true);
    res.status(201).json({ message: 'Conta adicionada com sucesso.', account: newAccount });
});

app.put('/api/accounts/:username/appids', (req, res) => {
    const { username } = req.params;
    const { appids } = req.body;
    if (!Array.isArray(appids)) {
        return res.status(400).json({ message: 'Os AppIDs devem ser um array.' });
    }
    const account = accountsData.find(acc => acc.username === username);
    if (!account) return res.status(404).json({ message: 'Conta não encontrada.' });
    account.appids = appids;
    savePersistentAccounts();
    const clientData = steamClients[username];
    if (clientData && clientData.isFarming && clientData.client.steamID) {
        startFarming(username, appids);
    }
    console.log(`🎮 AppIDs atualizados para '${username}': ${appids.join(', ')}`);
    res.status(200).json({ message: 'Jogos atualizados com sucesso.', account });
});

app.post('/api/accounts/:username/steam-guard', (req, res) => {
    const { username } = req.params;
    const { code } = req.body;
    const clientData = steamClients[username];
    if (clientData && clientData.steamGuardCallback) {
        clientData.steamGuardCallback(code);
        clientData.steamGuardCallback = null;
        res.status(200).json({ message: 'Código Steam Guard enviado.' });
    } else {
        res.status(400).json({ message: 'Nenhum pedido de Steam Guard ativo.' });
    }
});

app.post('/api/accounts/:username/toggle-farm', (req, res) => {
    const { username } = req.params;
    const clientData = steamClients[username];
    const account = accountsData.find(acc => acc.username === username);
    if (!clientData || !account) return res.status(404).json({ message: 'Conta não encontrada.' });
    if (!clientData.client.steamID) return res.status(409).json({ message: 'A conta não está logada.' });

    if (clientData.isFarming) {
        stopFarming(username);
        res.status(200).json({ message: 'Farm parado com sucesso.', isFarming: false });
    } else {
        startFarming(username, account.appids);
        res.status(200).json({ message: 'Farm iniciado com sucesso.', isFarming: true });
    }
});

app.delete('/api/accounts/:username', (req, res) => {
    const { username } = req.params;
    const accountIndex = accountsData.findIndex(acc => acc.username === username);
    if (accountIndex === -1) return res.status(404).json({ message: 'Conta não encontrada.' });
    const clientData = steamClients[username];
    if (clientData && clientData.client) clientData.client.logOff();
    accountsData.splice(accountIndex, 1);
    savePersistentAccounts();
    delete steamClients[username];
    const sentryPath = path.join(SENTRY_DIR, `${username}.bin`);
    if (fs.existsSync(sentryPath)) fs.unlinkSync(sentryPath);
    console.log(`🗑️ Conta '${username}' removida com sucesso.`);
    res.status(200).json({ message: `Conta '${username}' removida com sucesso.` });
});

// ---- INICIALIZAÇÃO ----
if (!fs.existsSync(SENTRY_DIR)) fs.mkdirSync(SENTRY_DIR, { recursive: true });
loadPersistentAccounts();
app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});

// criado, compilado e desenvolvido por covil.dev =)