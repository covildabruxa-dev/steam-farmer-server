// server.js - VERSÃO CORRIGIDA COM ROTA PARA MANTER O SERVIDOR ATIVO

const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const SteamUser = require('steam-user');

// --- AJUSTE PARA O RENDER ---
const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || __dirname;
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const SENTRY_DIR = path.join(DATA_DIR, 'sentry');
// --- FIM DO AJUSTE ---

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());

const steamClients = {};
let accountsData = [];
const TRACKING_INTERVAL = 60000; // 1 minuto

setInterval(() => {
    // ... (todo o seu código de setInterval continua aqui, sem alterações)
    let hasChanges = false;
    accountsData.forEach(account => {
        const clientData = steamClients[account.username];
        if (clientData && clientData.isFarming && clientData.client.steamID) {
            hasChanges = true;
            if (account.farmMode === 'goal') {
                const activeGamesToFarm = [];
                account.appids.forEach(game => {
                    if (game.farmedMinutes < game.goalMinutes) {
                        game.farmedMinutes++;
                        activeGamesToFarm.push({ game_id: game.appid });

                        if (game.goalMinutes > 0 && game.farmedMinutes >= game.goalMinutes) {
                            const goalAlreadyCompleted = account.completedGoals?.some(g => g.appid === game.appid);
                            if (!goalAlreadyCompleted) {
                                console.log(`🎉 Meta atingida para '${account.displayName}' no jogo ${game.appid}!`);
                                if (!account.completedGoals) account.completedGoals = [];
                                account.completedGoals.push({ appid: game.appid, date: new Date().toISOString() });
                            }
                        }
                    }
                });

                const currentFarmingIds = (clientData.currentlyFarming || []).map(g => g.game_id).sort();
                const newFarmingIds = activeGamesToFarm.map(g => g.game_id).sort();

                if (JSON.stringify(currentFarmingIds) !== JSON.stringify(newFarmingIds)) {
                    clientData.client.gamesPlayed(activeGamesToFarm);
                    clientData.currentlyFarming = activeGamesToFarm;
                }

                if (activeGamesToFarm.length === 0 && clientData.isFarming) {
                    console.log(`✅ Todas as metas atingidas para '${account.displayName}'. Parando farm.`);
                    stopFarming(account.username);
                }
            } else { // farmMode 'infinite'
                account.appids.forEach(game => { game.farmedMinutes++; });
            }
        }
    });
    if (hasChanges) savePersistentAccounts();
}, TRACKING_INTERVAL);


// --- O restante das suas funções (getGameDetails, startFarming, etc.) continuam aqui, sem alterações ---
function getGameDetails(appid) {
    return new Promise((resolve) => {
        https.get(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=brazilian`, (res) => { // l=brazilian para nomes em PT-BR
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const defaultResponse = { name: `Jogo (${appid})`, headerImage: null };
                    if (json[appid] && json[appid].success) {
                        resolve({ name: `${json[appid].data.name} (${appid})`, headerImage: json[appid].data.header_image });
                    } else { resolve(defaultResponse); }
                } catch (e) { resolve(defaultResponse); }
            });
        }).on('error', () => resolve({ name: `Jogo (${appid})`, headerImage: null }));
    });
}

async function fetchAndAssignGameDetails(account) {
    if (account && account.appids) {
        const appidsForDetails = account.appids.map(g => g.appid);
        account.gamesBeingFarmed = await Promise.all(appidsForDetails.map(id => getGameDetails(id)));
    }
}

async function startFarming(username) {
    const clientData = steamClients[username];
    const account = accountsData.find(acc => acc.username === username);
    if (clientData && account && clientData.client.steamID) {
        clientData.isFarming = true;
        let gamesToFarm = [];
        if (account.farmMode === 'goal') {
            gamesToFarm = account.appids.filter(g => g.farmedMinutes < g.goalMinutes).map(g => ({ game_id: g.appid }));
        } else {
            gamesToFarm = account.appids.map(g => ({ game_id: g.appid }));
        }
        
        const personaState = account.isFarmingOffline ? SteamUser.EPersonaState.Offline : SteamUser.EPersonaState.Online;
        clientData.client.setPersona(personaState);
        clientData.client.gamesPlayed(gamesToFarm);

        clientData.currentlyFarming = gamesToFarm;

        await fetchAndAssignGameDetails(account);
        
        console.log(`▶️ Iniciando farm para '${username}' no modo ${account.isFarmingOffline ? 'Offline' : 'Online'}.`);
        savePersistentAccounts();
    }
}

function stopFarming(username) {
    const clientData = steamClients[username];
    if (clientData) {
        if (clientData.client.steamID) {
             clientData.client.gamesPlayed([]);
             clientData.client.setPersona(SteamUser.EPersonaState.Online);
        }
        clientData.isFarming = false;
        
        clientData.currentlyFarming = [];

        console.log(`⏹️ Farm parado para '${username}'.`);
        savePersistentAccounts();
    }
}

function loginAccount(username, password = null, isInitialLogin = false) {
    const clientData = steamClients[username];
    if (!clientData || clientData.isLoggingIn) return;
    const account = accountsData.find(acc => acc.username === username);
    if (!account) return;
    
    account.loginKeyInvalid = false;

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
            console.log(`-> Senha/Sessão inválida para ${username}. Limpando loginKey e sinalizando para relogin.`);
            account.loginKey = null;
            account.loginKeyInvalid = true; 
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
            if (account.loginKeyInvalid) {
                account.loginKeyInvalid = false;
            }
            clientData.client.setPersona(SteamUser.EPersonaState.Online);
            fetchAndAssignGameDetails(account);
            console.log(`✅ '${username}' logado.`);
            if (clientData.isFarming) {
                startFarming(username);
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
        if (!steamClients[acc.username]) {
            const client = new SteamUser({ dataDirectory: null });
            steamClients[acc.username] = { client, steamGuardCallback: null, isFarming: false, isLoggingIn: false, currentlyFarming: [] };
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

// --- NOVA ROTA: HEALTH CHECK PARA MANTER O SERVIDOR ATIVO ---
app.get('/health', (req, res) => {
    // Apenas loga no console do Render para sabermos que está funcionando
    console.log(`Health check recebido às ${new Date().toLocaleTimeString()}`);
    res.status(200).send('OK'); // Responde com sucesso
});

app.get('/api/accounts', (req, res) => {
    // ... (suas outras rotas continuam aqui, sem alterações)
    const dataToSend = accountsData.map(acc => ({
        ...acc,
        isFarming: steamClients[acc.username]?.isFarming || false,
        isLoggingIn: steamClients[acc.username]?.isLoggingIn || false,
        needsSteamGuard: !!steamClients[acc.username]?.steamGuardCallback
    }));
    res.json(dataToSend);
});

app.post('/api/accounts', async (req, res) => {
    const { username, password, displayName, appids } = req.body;
    if (accountsData.some(acc => acc.username === username)) {
        return res.status(409).json({ message: `Conta '${username}' já existe.` });
    }
    const appidsWithProgress = appids.map(appid => ({ appid, goalMinutes: 0, farmedMinutes: 0 }));
    const newAccount = { username, displayName, appids: appidsWithProgress, farmMode: 'infinite', loginKey: null, sentry: null, avatarHash: null, profileName: null, completedGoals: [], isFarmingOffline: false };
    accountsData.push(newAccount);
    
    initializeClients();
    loginAccount(username, password, true);
    await fetchAndAssignGameDetails(newAccount);
    savePersistentAccounts();
    res.status(201).json({ message: 'Conta adicionada com sucesso.', account: newAccount });
});

app.post('/api/accounts/:username/farm-mode', async (req, res) => {
    const { username } = req.params;
    const { mode, appids } = req.body;
    const account = accountsData.find(acc => acc.username === username);
    if (!account) return res.status(404).json({ message: 'Conta não encontrada.' });

    account.farmMode = mode;
    const newAppIds = new Set(appids.map(g => g.appid));

    const updatedAppids = appids.map(newGame => {
        const existingGame = account.appids.find(oldGame => oldGame.appid === newGame.appid);
        return {
            appid: newGame.appid,
            goalMinutes: mode === 'goal' ? newGame.goalMinutes : 0,
            farmedMinutes: existingGame ? existingGame.farmedMinutes : 0
        };
    });

    account.appids = updatedAppids;
    account.completedGoals = account.completedGoals?.filter(goal => newAppIds.has(goal.appid));
    await fetchAndAssignGameDetails(account);

    const clientData = steamClients[username];
    if (clientData && clientData.isFarming) {
        startFarming(username);
    }

    savePersistentAccounts();
    res.status(200).json({ message: `Modo de farm atualizado.`, account });
});

app.post('/api/accounts/:username/relogin', (req, res) => {
    const { username } = req.params;
    const { password } = req.body;
    const account = accountsData.find(acc => acc.username === username);
    const clientData = steamClients[username];

    if (!account || !clientData) {
        return res.status(404).json({ message: 'Conta não encontrada.' });
    }
    if (!password) {
        return res.status(400).json({ message: 'Senha é obrigatória.' });
    }

    console.log(`Tentando relogin para '${username}' com nova senha.`);
    loginAccount(username, password, true);
    savePersistentAccounts();
    res.status(200).json({ message: 'Tentativa de relogin iniciada.' });
});

app.post('/api/accounts/:username/toggle-offline', (req, res) => {
    const { username } = req.params;
    const account = accountsData.find(acc => acc.username === username);
    if (!account) return res.status(404).json({ message: 'Conta não encontrada.' });

    account.isFarmingOffline = !account.isFarmingOffline;
    
    const clientData = steamClients[username];
    if (clientData && clientData.isFarming && clientData.client.steamID) {
        const personaState = account.isFarmingOffline ? SteamUser.EPersonaState.Offline : SteamUser.EPersonaState.Online;
        clientData.client.setPersona(personaState);
    }

    savePersistentAccounts();
    res.status(200).json({ message: 'Modo de farm offline atualizado.', isFarmingOffline: account.isFarmingOffline });
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
    if (!account.farmMode) return res.status(400).json({ message: 'Defina um modo de farm antes de iniciar.'});
    if (!clientData.client.steamID) return res.status(409).json({ message: 'A conta não está logada.' });

    if (clientData.isFarming) {
        stopFarming(username);
        res.status(200).json({ message: 'Farm parado com sucesso.', isFarming: false });
    } else {
        startFarming(username);
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

