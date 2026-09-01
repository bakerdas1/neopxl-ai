export function isPrivateOrReservedHost(hostname) {
    const h = (hostname || '').toLowerCase().trim();
    if (
        h === 'localhost' ||
        h === '127.0.0.1' ||
        h === '::1' ||
        h === '0.0.0.0' ||
        h === '169.254.169.254' ||
        h.endsWith('.localhost') ||
        h.endsWith('.local') ||
        h.endsWith('.internal')
    ) {
        return true;
    }
    const ipv4Match = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
        const a = Number(ipv4Match[1]);
        const b = Number(ipv4Match[2]);
        if (a === 10) return true;
        if (a === 127) return true;
        if (a === 0) return true;
        if (a === 169 && b === 254) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
    }
    return false;
}

/**
 * Function to check if a file is valid based on its URL or MIME type
 * @param {string} file - The URL to the file
 * @returns {Promise<boolean>} - Resolves to true if the file is valid, false otherwise
 */
export async function isValidFile(file) {
    const allowedExtensions = ['pdf', 'png', 'jpg', 'jpeg', 'txt', 'docx', 'html'];
    const allowedMimeTypes = {
        pdf: 'application/pdf',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        txt: 'text/plain',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        html: 'text/html',
    };

    let parsedUrl;
    try {
        parsedUrl = new URL(file);
    } catch {
        return false;
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return false;
    }
    if (isPrivateOrReservedHost(parsedUrl.hostname)) {
        return false;
    }

    const urlPath = parsedUrl.pathname;
    const extensionRegex = new RegExp(`\\.(${allowedExtensions.join('|')})$`, 'i');

    if (!extensionRegex.test(urlPath)) {
        return false;
    }

    // Optional: Check the MIME type if query parameters are used
    try {
        const response = await axios.head(file, { timeout: 10000 });
        const contentType = response.headers?.['content-type'] || '';
        return Object.values(allowedMimeTypes).some(mime => contentType.startsWith(mime));
    } catch (error) {
        console.error('Error checking MIME type:', error.message);
        return false;
    }
}
