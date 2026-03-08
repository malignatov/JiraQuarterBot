const https = require('https');

const JIRA_HOST = process.env.JIRA_HOST;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

// Map for Health status to Emojis
const HEALTH_EMOJI_MAP = {
    'Green': ':white_circle:',
    'Yellow': ':yellow_circle:',
    'Red': ':red_circle:',
    'Blue': ':blue_circle:'
};

let fieldMapCache = null;

function getAuthHeader() {
    return 'Bearer ' + JIRA_API_TOKEN;
}

function formatPTRank(rank) {
    if (rank === undefined || rank === null) return '';
    const digits = String(rank).split('');
    const emojiMap = {
        '0': '0️⃣', '1': '1️⃣', '2': '2️⃣', '3': '3️⃣', '4': '4️⃣',
        '5': '5️⃣', '6': '6️⃣', '7': '7️⃣', '8': '8️⃣', '9': '9️⃣'
    };
    return digits.map(d => emojiMap[d] || d).join('');
}

function formatDate(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString);
    const options = { day: 'numeric', month: 'short', year: 'numeric' };
    return date.toLocaleDateString('en-GB', options);
}

function stripJiraMarkup(text) {
    if (!text || typeof text !== 'string') return '';
    return text
        // Remove Jira heading markup: h1. h2. h3. h4. h5. h6.
        .replace(/^h[1-6]\.\.?\s*/gm, '')
        // Remove +bold+ markup
        .replace(/\+(.*?)\+/g, '$1')
        // Remove _italic_ markup
        .replace(/(?<![a-zA-Z0-9])_(.*?)_(?![a-zA-Z0-9])/g, '$1')
        // Remove {color} tags
        .replace(/\{color[^}]*\}/g, '')
        // Remove [link text|url] -> link text
        .replace(/\[([^|\]]+)\|([^\]]+)\]/g, '$1')
        // Remove [url] standalone links
        .replace(/\[([^\]]+)\]/g, '$1')
        // Remove ordered list markers: # ## ###
        .replace(/^\s*#{1,3}\s+/gm, '• ')
        // Remove unordered list markers: * ** ***
        .replace(/^\s*\*{1,3}\s+/gm, '• ')
        // Remove horizontal rules ----
        .replace(/^-{4,}$/gm, '')
        // Clean up \r\n to \n
        .replace(/\r\n/g, '\n')
        // Collapse multiple blank lines
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function fetchFields() {
    return new Promise((resolve, reject) => {
        if (!JIRA_HOST || !JIRA_EMAIL || !JIRA_API_TOKEN) {
            return reject(new Error("Jira credentials are missing in .env"));
        }

        const options = {
            hostname: JIRA_HOST,
            port: 443,
            path: '/rest/api/2/field',
            method: 'GET',
            headers: {
                'Authorization': getAuthHeader(),
                'Accept': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        const fields = JSON.parse(data);
                        resolve(fields);
                    } catch (e) {
                        reject(new Error("Failed to parse Jira fields response"));
                    }
                } else {
                    reject(new Error(`Jira Fields API Error: ${res.statusCode}`));
                }
            });
        });
        req.on('error', (e) => reject(e));
        req.end();
    });

}

async function getFieldIdMap() {
    if (fieldMapCache) return fieldMapCache;
    try {
        const fields = await fetchFields();
        fieldMapCache = {};
        fields.forEach(field => {
            fieldMapCache[field.name.toLowerCase()] = field.id;
        });
        return fieldMapCache;
    } catch (e) {
        console.error("Error fetching fields:", e);
        return {};
    }
}

function runJql(jql) {
    return new Promise((resolve, reject) => {
        if (!JIRA_HOST || !JIRA_EMAIL || !JIRA_API_TOKEN) {
            return reject(new Error("Jira credentials are missing in .env"));
        }

        // Note: /rest/api/3/search/jql 
        const requestData = JSON.stringify({
            jql: jql,
            maxResults: 50,
            fields: ["summary", "status", "duedate", "labels", "description", "customfield_*", "*all"],
            // Requesting all fields to be safe since we don't know IDs yet during this call if we construct it dynamically?
            // Actually, we can just request keys if we knew them. 
            // For simplicity, let's request commonly used standard fields and rely on "fields" property return.
            // But since we want custom fields for Health/Rank, we might need to be specific if *all isn't supporting.
            // However, typical JQL search returns fields if they are requested or *all.
            // Let's try explicit fields from map? require two passes?
            // No, JQL search usually returns all navigable fields if fields is not specified?
            // "By default, the new endpoint only returns issue IDs."
            // So we MUST specify fields. 
            // Let's use ["*all"] to retrieve everything, then filter in code.
            fields: ["*all"]
        });

        const options = {
            hostname: JIRA_HOST,
            port: 443,
            path: '/rest/api/2/search',
            method: 'POST',
            headers: {
                'Authorization': getAuthHeader(),
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        const json = JSON.parse(data);
                        resolve(json);
                    } catch (e) {
                        reject(new Error("Failed to parse Jira response"));
                    }
                } else {
                    try {
                        const errorJson = JSON.parse(data);
                        const errorMessages = errorJson.errorMessages ? errorJson.errorMessages.join(', ') : 'Unknown Jira Error';
                        reject(new Error(errorMessages));
                    } catch (e) {
                        reject(new Error(`Jira API Error: ${res.statusCode}`));
                    }
                }
            });
        });

        req.on('error', (e) => {
            reject(e);
        });

        req.write(requestData);
        req.end();
    });
}

async function searchIssues(jql, productTrack) {
    productTrack = productTrack || 'IVA';
    try {
        // Parallel fetch of fields and issues usually better, but we need fields to map?
        // Actually, we can fetch issues with *all, and fetch fields to map names to IDs, then look up IDs in issues.

        const [fieldMap, searchResult] = await Promise.all([
            getFieldIdMap(),
            runJql(jql)
        ]);

        const issues = searchResult.issues || [];

        // Helper to find ID by name
        const findId = (namePart) => {
            for (const [name, id] of Object.entries(fieldMap)) {
                if (name.includes(namePart.toLowerCase())) return id;
            }
            return null;
        };

        const healthFieldId = 'customfield_24922';
        const ptRankFieldId = findId("pt rank") || findId("rank");
        const notesFieldId = 'customfield_19964';

        const formattedIssues = [];

        for (const issue of issues) {
            const fields = issue.fields;

            // Health
            let healthVal = "Green";
            if (healthFieldId && fields[healthFieldId]) {
                const fieldVal = fields[healthFieldId];
                healthVal = (fieldVal.value) ? fieldVal.value : fieldVal;
            }
            const healthEmoji = HEALTH_EMOJI_MAP[healthVal] || ':green_circle:';


            // PT Rank
            let ptRankVal = null;
            if (ptRankFieldId && fields[ptRankFieldId] !== undefined) {
                ptRankVal = fields[ptRankFieldId];
            }
            const ptRankEmoji = formatPTRank(ptRankVal);

            // Product Track (customfield_27455) - show if not IVA
            let productTrackPart = '';
            const ptField = fields['customfield_27455'];
            const ptVal = ptField && ptField.value ? ptField.value : ptField;
            if (ptVal && ptVal.toUpperCase() !== productTrack.toUpperCase()) {
                productTrackPart = `(Not ${productTrack}: "${ptVal}") `;
            }

            // Summary & ID
            const key = issue.key;
            const summary = fields.summary;

            // Date: prefer duedate, fall back to Target Delivery Quarter
            let dueDate;
            if (fields.duedate) {
                dueDate = formatDate(fields.duedate);
            } else if (fields['customfield_21998']) {
                const quarter = fields['customfield_21998'];
                dueDate = (quarter && quarter.value) ? quarter.value : quarter;
            } else {
                dueDate = "Unknown";
            }

            // Commitment status (customfield_31650)
            const commitField = fields['customfield_31650'];
            const commitVal = commitField && commitField.value ? commitField.value : commitField;

            // Build commitment part for the bullet point
            let commitPart = '';
            if (commitVal === 'Yes' && fields['customfield_33251']) {
                commitPart = `, committed on ${formatDate(fields['customfield_33251'])}`;
            } else if (commitVal === 'Yes') {
                commitPart = `, committed - yes`;
            } else if (commitVal === 'No') {
                commitPart = `, :no_entry_sign: not committed`;
            }

            // Glip team link (customfield_21660)
            let glipPart = '';
            const glipLink = fields['customfield_21660'];
            if (glipLink) {
                const glipUrl = (typeof glipLink === 'string') ? glipLink : (glipLink.url || glipLink.value || '');
                if (glipUrl) {
                    glipPart = ` :pencil: [Glip chat](${glipUrl})`;
                }
            }

            // Notes (custom field only, no description fallback)
            let notesVal = "";
            if (notesFieldId && fields[notesFieldId]) {
                notesVal = fields[notesFieldId];
            }

            const issueLink = `https://${JIRA_HOST}/browse/${key}`;
            const headerLine = `\u200A ${productTrackPart}${ptRankEmoji ? ptRankEmoji + ' ' : ''}[${key}](${issueLink}) **${summary}**${glipPart}`;

            let issueText = `${healthEmoji} ${headerLine}`;

            // First bullet: business expectation with commitment
            issueText += ` ▫️ business exp.: ${dueDate}${commitPart}\n`;

            if (notesVal) {
                // Only keep the most recent note (before the first --- or "history details" separator)
                const latestNote = notesVal.split(/\n?-{3,}\n?|\[?history details\]?/i)[0].trim();

                // Convert [Title|URL] Jira wiki links to markdown links
                let cleanedNotes = latestNote
                    .replace(/\[([^|\]]+)\|([^\]]+)\]/g, '[$1]($2)');

                // Auto-link Jira issue keys to clickable links (skip already linked ones)
                cleanedNotes = cleanedNotes.replace(
                    /(?<!\[)(?<!\/)(?<!\w)\b([A-Z]+-\d+)\b(?!\]|\))/g,
                    (match, issueKey) => `[${issueKey}](https://${JIRA_HOST}/browse/${issueKey})`
                );

                // Format each line of notes as an indented bullet point
                const noteLines = cleanedNotes.split('\n')
                    .map(l => l.trim())
                    .filter(l => l.length > 0);
                for (const line of noteLines) {
                    issueText += `\u2003\u2003• ${line}\n`;
                }
            }

            formattedIssues.push(issueText.trim());
        }

        return formattedIssues;

    } catch (e) {
        console.error("Jira Search Failed", e);
        throw e;
    }
}

module.exports = { searchIssues };
