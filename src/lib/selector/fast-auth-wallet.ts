import type {
  Account,
  BrowserWallet,
  Network,
  Optional,
  Transaction,
  WalletBehaviourFactory,
  WalletModuleFactory,
} from "@near-wallet-selector/core";
import { createAction } from "@near-wallet-selector/wallet-utils";
import * as nearAPI from "near-api-js";

import icon from "./fast-auth-icon";
import { FastAuthWalletConnection } from "./fastAuthWalletConnection";

const {
  transactions: { encodeSignedDelegate },
} = nearAPI

export interface FastAuthWalletParams {
  walletUrl?: string;
  iconUrl?: string;
  deprecated?: boolean;
  successUrl?: string;
  failureUrl?: string;
  relayerUrl?: string;
}

interface FastAuthWalletState {
  wallet: FastAuthWalletConnection;
  keyStore: nearAPI.keyStores.BrowserLocalStorageKeyStore;
  near: any;
}

interface FastAuthWalletExtraOptions {
  walletUrl: string;
}

const resolveWalletUrl = (network: Network, walletUrl?: string) => {
  if (walletUrl) {
    return walletUrl;
  }

  switch (network.networkId) {
    case "mainnet":
      return "http://localhost:3000";
    case "testnet":
      return "http://localhost:3000";
    default:
      throw new Error("Invalid wallet url");
  }
};

const setupWalletState = async (
  params: FastAuthWalletExtraOptions,
  network: Network
): Promise<FastAuthWalletState> => {
  const keyStore = new nearAPI.keyStores.BrowserLocalStorageKeyStore();

  const near = await nearAPI.connect({
    keyStore,
    walletUrl: params.walletUrl,
    ...network,
    headers: {},
  });

  const wallet = new FastAuthWalletConnection(near, "near_app");

  return {
    wallet,
    keyStore,
    near
  };
};

const FastAuthWallet: WalletBehaviourFactory<
  BrowserWallet,
  { params: FastAuthWalletExtraOptions }
> = async ({ metadata, options, store, params, logger, relayerUrl }) => {
  const _state = await setupWalletState(params, options.network);
  const getAccounts = async (): Promise<Array<Account>> => {
    const accountId = _state.wallet.getAccountId();
    const account = _state.wallet.account();

    if (!accountId || !account) {
      return [];
    }

    const publicKey = await account.connection.signer.getPublicKey(
      account.accountId,
      options.network.networkId
    );
    return [
      {
        accountId,
        publicKey: publicKey ? publicKey.toString() : "",
      },
    ];
  };

  const transformTransactions = async (
    transactions: Array<Optional<Transaction, "signerId">>
  ) => {
    const account = _state.wallet.account();
    const { networkId, signer, provider } = account.connection;

    const localKey = await signer.getPublicKey(account.accountId, networkId);

    return Promise.all(
      transactions.map(async (transaction, index) => {
        const actions = transaction.actions.map((action) =>
          createAction(action)
        );
        const accessKey = await account.accessKeyForTransaction(
          transaction.receiverId,
          actions,
          localKey
        );

        if (!accessKey) {
          throw new Error(
            `Failed to find matching key for transaction sent to ${transaction.receiverId}`
          );
        }

        const block = await provider.block({ finality: "final" });

        return nearAPI.transactions.createTransaction(
          account.accountId,
          nearAPI.utils.PublicKey.from(accessKey.public_key),
          transaction.receiverId,
          accessKey.access_key.nonce + index + 1,
          actions,
          nearAPI.utils.serialize.base_decode(block.header.hash)
        );
      })
    );
  };

  return {
    async signIn({ contractId, methodNames, successUrl, failureUrl, email, accountId, isRecovery }) {
      const existingAccounts = await getAccounts();

      if (existingAccounts.length) {
        return existingAccounts;
      }

      await _state.wallet.requestSignIn({
        contractId,
        methodNames,
        successUrl,
        failureUrl,
        email,
        accountId,
        isRecovery
      });

      return getAccounts();
    },

    async signOut() {
      if (_state.wallet.isSignedIn()) {
        _state.wallet.signOut();
      }
    },

    async getAccounts() {
      return getAccounts();
    },

    async verifyOwner() {
      throw new Error(`Method not supported by ${metadata.name}`);
    },

    async signAndSendTransaction({ receiverId, actions, signerId }) {
      const account = _state.wallet.account();
  
      const signedDelegate = await account.signedDelegate({
        actions: actions.map((action) => createAction(action)),
        blockHeightTtl: 60,
        receiverId,
      });
  
      await fetch(relayerUrl, {
        method: 'POST',
        mode: 'cors',
        body: JSON.stringify(Array.from(encodeSignedDelegate(signedDelegate))),
        headers: new Headers({ 'Content-Type': 'application/json' }),
      });
    },
  
    async signAndSendTransactions({ transactions }) {
  
      for (let { receiverId, signerId, actions } of transactions) {
        await this.signAndSendTransaction({ receiverId, signerId, actions });
      }
    }
  };
};

export function setupFastAuthWallet({
  walletUrl,
  iconUrl = icon,
  deprecated = false,
  successUrl = "",
  failureUrl = "",
  relayerUrl = ""
}: FastAuthWalletParams = {}): WalletModuleFactory<BrowserWallet> {
  return async (moduleOptions) => {
    return {
      id: "fast-auth-wallet",
      type: "browser",
      metadata: {
        name: "FastAuthWallet",
        description: null,
        iconUrl,
        deprecated,
        available: true,
        successUrl,
        failureUrl,
        walletUrl: resolveWalletUrl(moduleOptions.options.network, walletUrl),
      },
      init: (options) => {
        return FastAuthWallet({
          ...options,
          relayerUrl,
          params: {
            walletUrl: resolveWalletUrl(options.options.network, walletUrl),
          },
        });
      },
    };
  };
}