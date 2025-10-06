// server.js - VERSÃO COM LOGS EM TEMPO REAL E BUSCA DE JOGOS DA BIBLIOTECA (SEM MULTIPLICADOR)

const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const SteamUser = require('steam-user');

const DATA_DIR = process.env.RENDER_DISK_MOUNT_PATH || __dirname;
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const SENTRY_DIR = path.join(DATA_DIR, 'sentry');

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());

// --- NOVO SISTEMA DE LOGS ---
let logs = [];
const MAX_LOGS = 200;

function logMessage(message) {
    const timestamp = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const logEntry = `[${timestamp}] ${message}`;
    
    console.log(message); // Mantém o log no console do Render
    
    logs.unshift(logEntry); // Adiciona no início para os mais recentes ficarem primeiro
    if (logs.length > MAX_LOGS) {
        logs.pop(); // Remove o mais antigo
    }
}

const FILLER_APP_IDS = [753, 440, 620, 228980, 393380, 107410, 238960, 252490, 304930, 346110, 218620, 230410];
const steamClients = {};
let accountsData = [];
const TRACKING_INTERVAL = 60000;

setInterval(() => {
    let hasChanges = false;
    accountsData.forEach(account => {
        const clientData = steamClients[account.username];
        if (!clientData) return;

        if (account.isFarmEnabled && !clientData.client.steamID && !clientData.isLoggingIn) {
            logMessage(`[Watchdog] Conta '${account.username}' deveria estar farmando, mas está offline. Tentando reconectar...`);
            loginAccount(account.username);
        }

        if (clientData.isFarming && clientData.client.steamID) {
            hasChanges = true;
            if (account.farmMode === 'goal') {
                const activeGamesToFarm = [];
                account.appids.forEach(game => {
                    if (game.farmedMinutes < game.goalMinutes) {
                        game.farmedMinutes++;
                        activeGamesToFarm.push({ game_id: game.appid });

                        if (game.goalMinutes > 0 && game.farmedMinutes >= game.goalMinutes) {
                            if (!account.completedGoals?.some(g => g.appid === game.appid)) {
                                logMessage(`🎉 Meta atingida para '${account.displayName}' no jogo ${game.appid}!`);
                                if (!account.completedGoals) account.completedGoals = [];
                                account.completedGoals.push({ appid: game.appid, date: new Date().toISOString() });
                            }
                        }
                    }
                });
                
                if (activeGamesToFarm.length === 0 && clientData.isFarming) {
                    logMessage(`✅ Todas as metas atingidas para '${account.displayName}'. Parando farm.`);
                    stopFarming(account.username);
                } else {
                    const currentFarmingIds = (clientData.currentlyFarming || []).map(g => g.game_id).sort();
                    const newFarmingIds = buildFarmList(account).map(g => g.game_id).sort();
                    if (JSON.stringify(currentFarmingIds) !== JSON.stringify(newFarmingIds)) {
                        startFarming(account.username);
                    }
                }

            } else {
                account.appids.forEach(game => { game.farmedMinutes++; });
            }
        }
    });
    if (hasChanges) savePersistentAccounts();
}, TRACKING_INTERVAL);


function getGameDetails(appid) {
    return new Promise((resolve) => {
        https.get(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=brazilian`, (res) => {
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

function buildFarmList(account) {
    if (account.farmMode === 'goal') {
        // Para o modo de metas, retorna apenas os jogos que ainda não atingiram a meta.
        return account.appids
            .filter(g => g.farmedMinutes < g.goalMinutes)
            .map(g => ({ game_id: g.appid }));
    } else { 
        // Para o modo infinito, retorna todos os jogos selecionados.
        return account.appids.map(g => ({ game_id: g.appid }));
    }
}

async function startFarming(username) {
    const clientData = steamClients[username];
    const account = accountsData.find(acc => acc.username === username);
    if (clientData && account && clientData.client.steamID) {
        clientData.isFarming = true;
        const gamesToFarm = buildFarmList(account);
        
        if(gamesToFarm.length === 0 && account.farmMode === 'goal') {
            logMessage(`ℹ️ Nenhum jogo com meta ativa para farmar em '${username}'.`);
            stopFarming(username);
            return;
        }

        const personaState = account.isFarmingOffline ? SteamUser.EPersonaState.Offline : SteamUser.EPersonaState.Online;
        clientData.client.setPersona(personaState);
        clientData.client.gamesPlayed(gamesToFarm);
        clientData.currentlyFarming = gamesToFarm;

        await fetchAndAssignGameDetails(account);
        logMessage(`▶️ Iniciando farm para '${username}' com ${gamesToFarm.length} jogo(s).`);
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
        logMessage(`⏹️ Farm parado para '${username}'.`);
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
    logMessage(`Tentando conectar '${username}'...`);
}

function setupSteamClientEvents(username, client) {
    client.on('error', (err) => {
        const clientData = steamClients[username];
        if (!clientData) return;
        let errorMsg = SteamUser.EResult[err.eresult] || `Código: ${err.eresult}`;
        logMessage(`❌ Erro para '${username}': ${errorMsg}.`);
        const account = accountsData.find(acc => acc.username === username);

        if (err.eresult === SteamUser.EResult.InvalidPassword && account) {
            logMessage(`-> Senha/Sessão inválida para ${username}. Limpando loginKey e sinalizando para relogin.`);
            account.loginKey = null;
            account.loginKeyInvalid = true;
            account.isFarmEnabled = false;
            savePersistentAccounts();
        } else if (account && account.isFarmEnabled) {
            logMessage(`-> Tentando reconectar '${username}' em 30 segundos devido a erro.`);
            setTimeout(() => loginAccount(username), 30000);
        }
        clientData.isLoggingIn = false;
        clientData.isFarming = false;
    });

    client.on('loggedOn', () => {
        const clientData = steamClients[username];
        const account = accountsData.find(acc => acc.username === username);
        if (clientData && account) {
            clientData.isLoggingIn = false;
            account.loginKeyInvalid = false;
            logMessage(`✅ '${username}' logado.`);
            if (account.isFarmEnabled) {
                logMessage(`-> Recuperando farm para '${username}'...`);
                startFarming(username);
            } else {
                 clientData.client.setPersona(SteamUser.EPersonaState.Online);
            }
            fetchAndAssignGameDetails(account);
        }
    });

    client.on('disconnected', (eresult, msg) => {
        logMessage(`🔌 '${username}' foi desconectado: ${msg}. EResult: ${eresult}`);
        const clientData = steamClients[username];
        const account = accountsData.find(acc => acc.username === username);
        if (clientData) {
            clientData.isFarming = false;
            if (account && account.isFarmEnabled) {
                logMessage(`-> Tentando reconectar '${username}' em 30 segundos...`);
                setTimeout(() => loginAccount(username), 30000);
            }
        }
    });

    client.on('user', (sid, user) => {
        if (client.steamID && sid.getSteamID64() === client.steamID.getSteamID64()) {
            const account = accountsData.find(acc => acc.username === username);
            if (!account) return;
            account.avatarHash = user.avatar_hash ? user.avatar_hash.toString('hex') : null;
            account.profileName = user.player_name || null;
        }
    });

    client.on('steamGuard', (domain, callback) => {
        const clientData = steamClients[username];
        if (clientData) {
            clientData.steamGuardCallback = callback;
            clientData.isLoggingIn = false;
            logMessage(`❗ Steam Guard solicitado para ${username}. Aguardando código via API.`);
        }
    });
    
    client.on('loginKey', (key) => { const acc = accountsData.find(a => a.username === username); if (acc) { acc.loginKey = key; savePersistentAccounts(); } });
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

function savePersistentAccounts() { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accountsData, null, 2), 'utf8'); }

function initializeClients() {
    accountsData.forEach(acc => {
        if (!steamClients[acc.username]) {
            const client = new SteamUser({ dataDirectory: null, autoRelogin: false });
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
    logMessage(`Carregando ${accountsData.length} conta(s)...`);
    accountsData.forEach(acc => { loginAccount(acc.username); });
}

// ---- ROTAS DA API ----

app.get('/health', (req, res) => { logMessage(`Health check recebido.`); res.status(200).send('OK'); });

app.get('/api/logs', (req, res) => { res.json(logs); });

app.get('/api/accounts', (req, res) => {
    const dataToSend = accountsData.map(acc => ({ ...acc, isFarming: steamClients[acc.username]?.isFarming || false, isLoggingIn: steamClients[acc.username]?.isLoggingIn || false, needsSteamGuard: !!steamClients[acc.username]?.steamGuardCallback }));
    res.json(dataToSend);
});

app.post('/api/accounts', async (req, res) => {
    const { username, password, displayName, appids } = req.body;
    if (accountsData.some(acc => acc.username === username)) return res.status(409).json({ message: `Conta '${username}' já existe.` });
    const appidsWithProgress = appids.map(appid => ({ appid, goalMinutes: 0, farmedMinutes: 0 }));
    const newAccount = { username, displayName, appids: appidsWithProgress, farmMode: 'infinite', loginKey: null, sentry: null, avatarHash: null, profileName: null, completedGoals: [], isFarmingOffline: false, isFarmEnabled: false, ownedGames: [] };
    accountsData.push(newAccount);
    
    initializeClients();
    loginAccount(username, password, true);
    await fetchAndAssignGameDetails(newAccount);
    savePersistentAccounts();
    res.status(201).json({ message: 'Conta adicionada com sucesso.', account: newAccount });
});

app.post('/api/accounts/:username/fetch-games', (req, res) => {
    const { username } = req.params;
    const clientData = steamClients[username];
    const account = accountsData.find(acc => acc.username === username);

    if (!clientData || !account) return res.status(404).json({ message: 'Conta não encontrada.' });
    if (!clientData.client.steamID) return res.status(409).json({ message: 'A conta precisa estar logada para buscar os jogos.' });

    logMessage(`Iniciando busca de jogos para '${username}'...`);

    clientData.client.once('licenses', licenses => {
        const packageIDs = licenses.map(license => license.package_id);
        
        clientData.client.getProductInfo([], packageIDs, (err, apps, packages) => {
            if (err) {
                logMessage(`Erro ao buscar product info para '${username}': ${err}`);
                return res.status(500).json({ message: 'Erro ao buscar pacotes.' });
            }

            const appIDs = new Set();
            for (const pkg of Object.values(packages)) {
                pkg.appids.forEach(appid => appIDs.add(appid));
            }

            const appIDArray = Array.from(appIDs);

            clientData.client.getProductInfo(appIDArray, [], (err, apps, packages) => {
                if (err) {
                    logMessage(`Erro ao buscar detalhes dos apps para '${username}': ${err}`);
                    return res.status(500).json({ message: 'Erro ao buscar detalhes dos jogos.' });
                }

                const ownedGames = [];
                for (const app of Object.values(apps)) {
                    if (app.common && (app.common.type.toLowerCase() === 'game' || app.common.type.toLowerCase() === 'application')) {
                        ownedGames.push({
                            appid: parseInt(app.appid, 10),
                            name: app.common.name
                        });
                    }
                }
                
                ownedGames.sort((a, b) => a.name.localeCompare(b.name));
                account.ownedGames = ownedGames;
                savePersistentAccounts();
                logMessage(`✅ Biblioteca de '${username}' atualizada com ${ownedGames.length} jogos.`);
                res.status(200).json({ message: `Biblioteca atualizada com ${ownedGames.length} jogos.` });
            });
        });
    });
    clientData.client.requestFreeLicense([]);
});

app.post('/api/accounts/:username/farm-mode', async (req, res) => {
    const { username } = req.params;
    const { mode, appids } = req.body;
    const account = accountsData.find(acc => acc.username === username);
    if (!account) return res.status(404).json({ message: 'Conta não encontrada.' });

    account.farmMode = mode;
    const newAppIds = new Set(appids.map(g => g.appid));

    account.appids = appids.map(newGame => {
        const existingGame = account.appids.find(oldGame => oldGame.appid === newGame.appid);
        return { appid: newGame.appid, goalMinutes: mode === 'goal' ? newGame.goalMinutes : 0, farmedMinutes: existingGame ? existingGame.farmedMinutes : 0 };
    });
    
    account.completedGoals = account.completedGoals?.filter(goal => newAppIds.has(goal.appid));
    await fetchAndAssignGameDetails(account);

    if (steamClients[username] && account.isFarmEnabled) {
        startFarming(username);
    }
    savePersistentAccounts();
    res.status(200).json({ message: `Modo de farm atualizado.`, account });
});

app.post('/api/accounts/:username/relogin', (req, res) => {
    const { username } = req.params; const { password } = req.body;
    const account = accountsData.find(acc => acc.username === username);
    if (!account || !steamClients[username]) return res.status(404).json({ message: 'Conta não encontrada.' });
    if (!password) return res.status(400).json({ message: 'Senha é obrigatória.' });
    logMessage(`Tentando relogin para '${username}' com nova senha.`);
    loginAccount(username, password, true);
    res.status(200).json({ message: 'Tentativa de relogin iniciada.' });
});

app.post('/api/accounts/:username/toggle-offline', (req, res) => {
    const { username } = req.params;
    const account = accountsData.find(acc => acc.username === username);
    if (!account) return res.status(404).json({ message: 'Conta não encontrada.' });
    account.isFarmingOffline = !account.isFarmingOffline;
    if (steamClients[username] && account.isFarmEnabled && steamClients[username].client.steamID) {
        const personaState = account.isFarmingOffline ? SteamUser.EPersonaState.Offline : SteamUser.EPersonaState.Online;
        steamClients[username].client.setPersona(personaState);
    }
    savePersistentAccounts();
    res.status(200).json({ message: 'Modo de farm offline atualizado.', isFarmingOffline: account.isFarmingOffline });
});

app.post('/api/accounts/:username/steam-guard', (req, res) => {
    const { username } = req.params; const { code } = req.body;
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
    if (!clientData || !account) return res.status(404).json({ message: 'Conta não encontrada. Tente reiniciar o app.' });
    if (!clientData.client.steamID) return res.status(409).json({ message: 'A conta não está logada. Aguarde a conexão.' });

    if (account.isFarmEnabled) {
        account.isFarmEnabled = false;
        stopFarming(username);
        savePersistentAccounts();
        res.status(200).json({ message: 'Farm parado com sucesso.', isFarming: false });
    } else {
        account.isFarmEnabled = true;
        startFarming(username);
        savePersistentAccounts();
        res.status(200).json({ message: 'Farm iniciado com sucesso.', isFarming: true });
    }
});

app.delete('/api/accounts/:username', (req, res) => {
    const { username } = req.params;
    const accountIndex = accountsData.findIndex(acc => acc.username === username);
    if (accountIndex === -1) return res.status(404).json({ message: 'Conta não encontrada.' });
    stopFarming(username);
    if (steamClients[username] && steamClients[username].client) steamClients[username].client.logOff();
    accountsData.splice(accountIndex, 1);
    savePersistentAccounts();
    delete steamClients[username];
    const sentryPath = path.join(SENTRY_DIR, `${username}.bin`);
    if (fs.existsSync(sentryPath)) fs.unlinkSync(sentryPath);
    logMessage(`🗑️ Conta '${username}' removida com sucesso.`);
    res.status(200).json({ message: `Conta '${username}' removida com sucesso.` });
});

// ---- INICIALIZAÇÃO ----
if (!fs.existsSync(SENTRY_DIR)) fs.mkdirSync(SENTRY_DIR, { recursive: true });
loadPersistentAccounts();
app.listen(port, '0.0.0.0', () => {
  logMessage(`Servidor rodando em http://0.0.0.0:${port}`);
});