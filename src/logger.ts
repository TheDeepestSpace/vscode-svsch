let vscode: any;
try {
    vscode = require('vscode');
} catch {
    // Not running in VS Code
}

class Logger {
    private channel?: any;

    init() {
        if (vscode && !this.channel) {
            this.channel = vscode.window.createOutputChannel('SVSCH');
        }
    }

    log(message: string) {
        const formatted = `[${new Date().toLocaleTimeString()}] ${message}`;
        if (!this.channel) {
            console.log(`[SVSCH] ${formatted}`);
            return;
        }
        this.channel.appendLine(formatted);
    }

    error(message: string, error?: any) {
        const formatted = `[${new Date().toLocaleTimeString()}] ERROR: ${message}`;
        if (!this.channel) {
            console.error(`[SVSCH] ${formatted}`, error || '');
            return;
        }
        this.channel.appendLine(formatted);
        if (error) {
            if (error.stack) {
                this.channel.appendLine(error.stack);
            } else {
                this.channel.appendLine(JSON.stringify(error, null, 2));
            }
        }
        this.channel.show(true);
    }

    show() {
        this.channel?.show(true);
    }
}

export const logger = new Logger();
