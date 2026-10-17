// Helper to extract bracketed unit numbers, e.g., "Echo (Spanish) (181528)" -> "181528"
function extractUnitNumber(str) {
    if (!str) return null;
    const match = String(str).match(/\((\d+)\)/);
    return match ? match[1] : null;
}