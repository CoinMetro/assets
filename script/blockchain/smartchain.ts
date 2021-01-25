import { ActionInterface, CheckStepInterface } from "../generic/interface";
import { getTradingPairs, PairInfo, TokenInfo } from "../generic/subgraph";
import {
    getChainAllowlistPath,
    getChainAssetLogoPath,
    getChainTokenlistBasePath,
    getChainTokenlistPath
} from "../generic/repo-structure";
import { SmartChain } from "../generic/blockchains";
import { isPathExistsSync } from "../generic/filesystem";
import {
    addPairIfNeeded,
    generateTokensList,
    List,
    TokenItem,
    writeToFileWithUpdate
} from "../generic/tokenlists";
import { readJsonFile } from "../generic/json";
import { toChecksum } from "../generic/eth-address";
import { assetID, logoURI } from "../generic/asset";

const PancakeSwap_TradingPairsUrl = "https://api.bscgraph.org/subgraphs/name/wowswap";
const PancakeSwap_TradingPairsQuery = "query pairs {\\n  pairs(first: 400, orderBy: reserveUSD, orderDirection: desc) {\\n id\\n reserveUSD\\n trackedReserveETH\\n volumeUSD\\n    untrackedVolumeUSD\\n __typename\\n token0 {\\n id\\n symbol\\n name\\n decimals\\n __typename\\n }\\n token1 {\\n id\\n symbol\\n name\\n decimals\\n __typename\\n }\\n }\\n}\\n";
const PancakeSwap_MinLiquidity = 1000000;
const PrimaryTokens: string[] = ["WBNB", "BNB"];

function checkBSCTokenExists(id: string, tokenAllowlist: string[]): boolean {
    const logoPath = getChainAssetLogoPath(SmartChain, id);
    if (!isPathExistsSync(logoPath)) {
        return false;
    }
    if (tokenAllowlist.find(t => (id.toLowerCase() === t.toLowerCase())) === undefined) {
        //console.log(`Token not found in allowlist, ${id}`);
        return false;
    }
    return true;
}

function isTokenPrimary(token: TokenInfo): boolean {
    return (PrimaryTokens.find(t => (t === token.symbol.toUpperCase())) != undefined);
}

// check which token of the pair is the primary token, 1st, or 2nd, or 0 for none
function primaryTokenIndex(pair: PairInfo): number {
    if (isTokenPrimary(pair.token0)) {
        return 1;
    }
    if (isTokenPrimary(pair.token1)) {
        return 2;
    }
    return 0;
}

// Verify a trading pair, whether we support the tokens, has enough liquidity, etc.
function checkTradingPair(pair: PairInfo, minLiquidity: number, tokenAllowlist: string[]): boolean {
    if (!pair.id && !pair.reserveUSD && !pair.token0 && !pair.token1) {
        return false;
    }
    if (pair.reserveUSD < minLiquidity) {
        //console.log("pair with low liquidity:", pair.token0.symbol, "--", pair.token1.symbol, "  ", Math.round(pair.reserveUSD));
        return false;
    }
    if (!checkBSCTokenExists(pair.token0.id, tokenAllowlist)) {
        console.log("pair with unsupported 1st coin:", pair.token0.symbol, "--", pair.token1.symbol);
        return false;
    }
    if (!checkBSCTokenExists(pair.token1.id, tokenAllowlist)) {
        console.log("pair with unsupported 2nd coin:", pair.token0.symbol, "--", pair.token1.symbol);
        return false;
    }
    if (primaryTokenIndex(pair) == 0) {
        console.log("pair with no primary coin:", pair.token0.symbol, "--", pair.token1.symbol);
        return false;
    }
    //console.log("pair:", pair.token0.symbol, "--", pair.token1.symbol, "  ", pair.reserveUSD);
    return true;
}

async function retrievePancakeSwapPairs(): Promise<PairInfo[]> {
    console.log(`Retrieving pairs from PancakeSwap, liquidity limit USD ${PancakeSwap_MinLiquidity}`);

    // prepare phase, read allowlist
    const allowlist: string[] = readJsonFile(getChainAllowlistPath(SmartChain)) as string[];

    const pairs = await getTradingPairs(PancakeSwap_TradingPairsUrl, PancakeSwap_TradingPairsQuery);
    const filtered: PairInfo[] = [];
    pairs.forEach(x => {
        try {
            if (typeof(x) === "object") {
                const pairInfo = x as PairInfo;
                if (pairInfo) {
                    if (checkTradingPair(pairInfo, PancakeSwap_MinLiquidity, allowlist)) {
                        filtered.push(pairInfo);
                    }
                }
            }
        } catch (err) {
            console.log("Exception:", err);
        }
    });

    console.log("Retrieved & filtered", filtered.length, "pairs:");
    filtered.forEach(p => {
        console.log(`pair:  ${p.token0.symbol} -- ${p.token1.symbol} \t USD ${Math.round(p.reserveUSD)}`);
    });

    return filtered;
}

function tokenInfoFromSubgraphToken(token: TokenInfo): TokenItem {
    const idChecksum = toChecksum(token.id);
    return new TokenItem(
        assetID(20000714, idChecksum),
        "BEP20",
        idChecksum, token.name, token.symbol, parseInt(token.decimals.toString()),
        logoURI(idChecksum, "smartchain", "--"),
        []);
}

// Retrieve trading pairs from PancakeSwap
async function generateTokenlist(): Promise<void> {
    const tokenlistFile = getChainTokenlistBasePath(SmartChain);
    const json = readJsonFile(tokenlistFile);
    const list: List = json as List;
    console.log(`Tokenlist base, ${list.tokens.length} tokens`);
    
    const tradingPairs = await retrievePancakeSwapPairs();
    tradingPairs.forEach(p => {
        let tokenItem0 = tokenInfoFromSubgraphToken(p.token0);
        let tokenItem1 = tokenInfoFromSubgraphToken(p.token1);
        if (primaryTokenIndex(p) == 2) {
            // reverse
            const tmp = tokenItem1; tokenItem1 = tokenItem0; tokenItem0 = tmp;
        }
        addPairIfNeeded(tokenItem0, tokenItem1, list);
    });
    console.log(`Tokenlist updated, ${list.tokens.length} tokens`);

    const newList = generateTokensList("Smart Chain", list.tokens,
        "2020-10-03T12:37:57.000+00:00", // use constant here to prevent changing time every time
        0, 1, 0);
    writeToFileWithUpdate(getChainTokenlistPath(SmartChain), newList);
}

export class SmartchainAction implements ActionInterface {
    getName(): string { return "Binance Smartchain"; }

    getSanityChecks(): CheckStepInterface[] { return []; }

    async update(): Promise<void> {
        await generateTokenlist();
    }
}