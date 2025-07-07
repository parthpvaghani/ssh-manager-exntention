import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface SSHConnection {
    name: string;
    host: string;
    user: string;
    port?: number;
    keyFile?: string;
    gitName?: string;
    gitEmail?: string;
    password?: string;
}

class SSHConnectionProvider implements vscode.TreeDataProvider<SSHConnection> {
    private _onDidChangeTreeData: vscode.EventEmitter<SSHConnection | undefined | null | void> = new vscode.EventEmitter<SSHConnection | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<SSHConnection | undefined | null | void> = this._onDidChangeTreeData.event;

    private connections: SSHConnection[] = [];
    private configPath: string;

    constructor() {
        this.configPath = path.join(os.homedir(), '.vscode-ssh-manager.json');
        this.loadConnections();
    }

    refresh(): void {
        this.loadConnections();
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: SSHConnection): vscode.TreeItem {
        const isActive = this.isActiveIdentity(element);
        const item = new vscode.TreeItem(
            isActive ? `${element.name} (active)` : element.name,
            vscode.TreeItemCollapsibleState.None
        );
        item.tooltip = `${element.user}@${element.host}:${element.port || 22}\nKey: ${element.keyFile}`;
        item.description = `${element.user}@${element.host}`;
        item.contextValue = isActive ? 'sshConnectionActive' : 'sshConnection';
        item.command = {
            command: 'ssh-manager.connectToHost',
            title: 'Connect',
            arguments: [element]
        };
        return item;
    }

    getChildren(element?: SSHConnection): Thenable<SSHConnection[]> {
        if (!element) {
            // Merge managed and config identities, deduping by keyFile
            const configIdentities = this.getGitHubSSHIdentities();
            const all = [...this.connections];
            for (const c of configIdentities) {
                if (!all.find(e => e.keyFile === c.keyFile)) {
                    all.push(c);
                }
            }
            return Promise.resolve(all);
        }
        return Promise.resolve([]);
    }

    isActiveIdentity(connection: SSHConnection): boolean {
        // Check if this connection's keyFile is the active one in ~/.ssh/config for github.com
        const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
        if (!fs.existsSync(sshConfigPath)) {
            console.log('[SSH DEBUG] ~/.ssh/config not found for active check');
            return false;
        }
        const lines = fs.readFileSync(sshConfigPath, 'utf8').split(/\r?\n/);
        let inGitHubHost = false;
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.toLowerCase().startsWith('host ')) {
                inGitHubHost = trimmed.split(/\s+/)[1] === 'github.com';
            }
            if (inGitHubHost && trimmed.toLowerCase().startsWith('identityfile')) {
                const activeKey = trimmed.split(/\s+/)[1];
                const isActive = activeKey === connection.keyFile;
                console.log(`[SSH DEBUG] Checking active: ${activeKey} === ${connection.keyFile} => ${isActive}`);
                return isActive;
            }
        }
        return false;
    }

    private loadConnections(): void {
        try {
            if (fs.existsSync(this.configPath)) {
                const data = fs.readFileSync(this.configPath, 'utf8');
                this.connections = JSON.parse(data);
            } else {
                this.connections = [];
            }
        } catch (error) {
            console.error('Error loading SSH connections:', error);
            this.connections = [];
        }
    }

    saveConnections(): void {
        try {
            fs.writeFileSync(this.configPath, JSON.stringify(this.connections, null, 2));
        } catch (error) {
            console.error('Error saving SSH connections:', error);
            vscode.window.showErrorMessage('Failed to save SSH connections');
        }
    }

    addConnection(connection: SSHConnection): void {
        this.connections.push(connection);
        this.saveConnections();
        this.refresh();
    }

    updateConnection(index: number, connection: SSHConnection): void {
        this.connections[index] = connection;
        this.saveConnections();
        this.refresh();
    }

    deleteConnection(connection: SSHConnection): void {
        const index = this.connections.findIndex(c => c.name === connection.name);
        if (index !== -1) {
            this.connections.splice(index, 1);
            this.saveConnections();
            this.refresh();
        }
    }

    getConnections(): SSHConnection[] {
        return this.connections;
    }

    getGitHubSSHIdentities(): SSHConnection[] {
        return parseGitHubSSHIdentities();
    }

    setActiveGitHubIdentity(identityFile: string) {
        setActiveGitHubIdentity(identityFile);
        // Find the connection info for this keyFile
        const all = [...this.connections, ...this.getGitHubSSHIdentities()];
        const conn = all.find(c => c.keyFile === identityFile);
        if (conn && conn.gitName && conn.gitEmail) {
            updateGitConfigAuthor(conn.gitName, conn.gitEmail);
        }
        vscode.window.showInformationMessage('Active GitHub SSH identity and git author updated!');
    }
}

class SSHManager {
    private provider: SSHConnectionProvider;

    constructor(provider: SSHConnectionProvider) {
        this.provider = provider;
    }

    async addConnection(): Promise<void> {
        const name = await vscode.window.showInputBox({
            prompt: 'Enter connection name',
            placeHolder: 'GitHub Account Name (e.g. Work, Personal)'
        });
        if (!name) return;
        const gitName = await vscode.window.showInputBox({
            prompt: 'Enter git commit author name',
            placeHolder: 'Your Name'
        });
        if (!gitName) return;
        const gitEmail = await vscode.window.showInputBox({
            prompt: 'Enter git commit author email',
            placeHolder: 'your@email.com'
        });
        if (!gitEmail) return;
        const keyFiles = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Select SSH Key for GitHub',
            filters: {
                'SSH Keys': ['pem', 'key', 'rsa', 'pub']
            }
        });
        if (!keyFiles || keyFiles.length === 0) return;
        const keyFile = keyFiles[0].fsPath;
        const connection: SSHConnection = {
            name,
            host: 'github.com',
            user: 'git',
            port: 22,
            keyFile,
            gitName,
            gitEmail
        };
        this.provider.addConnection(connection);
        vscode.window.showInformationMessage(`GitHub SSH connection "${name}" added successfully`);
    }

    async connectToHost(connection: SSHConnection): Promise<void> {
        const terminal = vscode.window.createTerminal(`GitHub SSH: ${connection.name}`);
        let sshCommand = `ssh`;
        if (connection.keyFile) {
            sshCommand += ` -i "${connection.keyFile}"`;
        }
        sshCommand += ` git@github.com`;
        terminal.sendText(sshCommand);
        terminal.show();
        vscode.window.showInformationMessage(`Connecting to GitHub as ${connection.name}...`);
    }

    async editConnection(connection: SSHConnection): Promise<void> {
        const connections = this.provider.getConnections();
        const index = connections.findIndex(c => c.name === connection.name);
        if (index === -1) {
            vscode.window.showErrorMessage('Connection not found');
            return;
        }
        const name = await vscode.window.showInputBox({
            prompt: 'Edit connection name',
            value: connection.name
        });
        if (!name) return;
        const gitName = await vscode.window.showInputBox({
            prompt: 'Edit git commit author name',
            value: connection.gitName || ''
        });
        if (!gitName) return;
        const gitEmail = await vscode.window.showInputBox({
            prompt: 'Edit git commit author email',
            value: connection.gitEmail || ''
        });
        if (!gitEmail) return;
        const keyFiles = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Select SSH Key for GitHub',
            filters: {
                'SSH Keys': ['pem', 'key', 'rsa', 'pub']
            }
        });
        let keyFile = connection.keyFile;
        if (keyFiles && keyFiles.length > 0) {
            keyFile = keyFiles[0].fsPath;
        }
        const updatedConnection: SSHConnection = {
            name,
            host: 'github.com',
            user: 'git',
            port: 22,
            keyFile,
            gitName,
            gitEmail
        };
        this.provider.updateConnection(index, updatedConnection);
        vscode.window.showInformationMessage(`GitHub SSH connection "${name}" updated successfully`);
    }

    async deleteConnection(connection: SSHConnection): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to delete the connection "${connection.name}"?`,
            'Yes',
            'No'
        );

        if (confirm === 'Yes') {
            this.provider.deleteConnection(connection);
            vscode.window.showInformationMessage(`SSH connection "${connection.name}" deleted`);
        }
    }

    showConnections(): void {
        vscode.commands.executeCommand('ssh-connections.focus');
    }
}

// Utility to parse ~/.ssh/config for github.com identities
function parseGitHubSSHIdentities(): SSHConnection[] {
    const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
    const connections: SSHConnection[] = [];
    if (!fs.existsSync(sshConfigPath)) {
        console.log('[SSH DEBUG] ~/.ssh/config not found');
        return connections;
    }
    const lines = fs.readFileSync(sshConfigPath, 'utf8').split(/\r?\n/);
    let currentHost: string | null = null;
    let identityFile: string | null = null;
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.toLowerCase().startsWith('host ')) {
            if (currentHost === 'github.com' && identityFile) {
                connections.push({
                    name: path.basename(identityFile),
                    host: 'github.com',
                    user: 'git',
                    port: 22,
                    keyFile: identityFile
                });
                console.log(`[SSH DEBUG] Found github.com identity: ${identityFile}`);
            }
            currentHost = trimmed.split(/\s+/)[1];
            identityFile = null;
        } else if (trimmed.toLowerCase().startsWith('identityfile') && currentHost === 'github.com') {
            identityFile = trimmed.split(/\s+/)[1];
        }
    }
    // Add last entry if file ends with github.com
    if (currentHost === 'github.com' && identityFile) {
        connections.push({
            name: path.basename(identityFile),
            host: 'github.com',
            user: 'git',
            port: 22,
            keyFile: identityFile
        });
        console.log(`[SSH DEBUG] Found github.com identity: ${identityFile}`);
    }
    console.log(`[SSH DEBUG] Total github.com identities found: ${connections.length}`);
    return connections;
}

// Utility to set the active IdentityFile for github.com in ~/.ssh/config
function setActiveGitHubIdentity(identityFile: string) {
    const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
    if (!fs.existsSync(sshConfigPath)) return;
    let lines = fs.readFileSync(sshConfigPath, 'utf8').split(/\r?\n/);
    let inGitHubHost = false;
    let found = false;
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.toLowerCase().startsWith('host ')) {
            inGitHubHost = trimmed.split(/\s+/)[1] === 'github.com';
        }
        if (inGitHubHost && trimmed.toLowerCase().startsWith('identityfile')) {
            lines[i] = `    IdentityFile ${identityFile}`;
            found = true;
            break;
        }
    }
    // If not found, add it
    if (!found) {
        lines.push('Host github.com');
        lines.push(`    IdentityFile ${identityFile}`);
    }
    fs.writeFileSync(sshConfigPath, lines.join('\n'));
}

// Utility to update git config author in the current workspace
function updateGitConfigAuthor(name: string, email: string) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) return;
    const repoPath = workspaceFolders[0].uri.fsPath;
    const gitConfigPath = path.join(repoPath, '.git', 'config');
    if (!fs.existsSync(gitConfigPath)) return;
    let config = fs.readFileSync(gitConfigPath, 'utf8');
    // Replace or add user section
    if (/\[user\][^\[]*/.test(config)) {
        config = config.replace(/\[user\][^\[]*/,
            `[user]\n\tname = ${name}\n\temail = ${email}\n`);
    } else {
        config += `\n[user]\n\tname = ${name}\n\temail = ${email}\n`;
    }
    fs.writeFileSync(gitConfigPath, config);
}

export function activate(context: vscode.ExtensionContext) {
    const provider = new SSHConnectionProvider();
    const manager = new SSHManager(provider);

    // Register tree data provider
    vscode.window.registerTreeDataProvider('ssh-connections', provider);

    // Register commands
    const commands = [
        vscode.commands.registerCommand('ssh-manager.showConnections', () => manager.showConnections()),
        vscode.commands.registerCommand('ssh-manager.addConnection', () => manager.addConnection()),
        vscode.commands.registerCommand('ssh-manager.connectToHost', (connection: SSHConnection) => manager.connectToHost(connection)),
        vscode.commands.registerCommand('ssh-manager.editConnection', (connection: SSHConnection) => manager.editConnection(connection)),
        vscode.commands.registerCommand('ssh-manager.deleteConnection', (connection: SSHConnection) => manager.deleteConnection(connection)),
        vscode.commands.registerCommand('ssh-manager.setActiveGitHubIdentity', (connection: SSHConnection) => {
            provider.setActiveGitHubIdentity(connection.keyFile!);
            provider.refresh();
        })
    ];

    commands.forEach(command => context.subscriptions.push(command));

    vscode.window.showInformationMessage('SSH Manager extension activated!');
}

export function deactivate() { }