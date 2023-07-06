import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { MessagingMessagesRepository, NotesRepository, UserPublickeysRepository, UsersRepository } from '@/models/index.js';
import type { Config } from '@/config.js';
import { MemoryKVCache } from '@/misc/cache.js';
import type { UserPublickey } from '@/models/entities/UserPublickey.js';
import { CacheService } from '@/core/CacheService.js';
import type { Note } from '@/models/entities/Note.js';
import type { MessagingMessage } from '@/models/entities/MessagingMessage.js';
import { bindThis } from '@/decorators.js';
import { LocalUser, RemoteUser } from '@/models/entities/User.js';
import { getApId } from './type.js';
import { ApPersonService } from './models/ApPersonService.js';
import type { IObject } from './type.js';

export type UriParseResult = {
	/** wether the URI was generated by us */
	local: true;
	/** id in DB */
	id: string;
	/** hint of type, e.g. "notes", "users" */
	type: string;
	/** any remaining text after type and id, not including the slash after id. undefined if empty */
	rest?: string;
} | {
	/** wether the URI was generated by us */
	local: false;
	/** uri in DB */
	uri: string;
};

@Injectable()
export class ApDbResolverService implements OnApplicationShutdown {
	private publicKeyCache: MemoryKVCache<UserPublickey | null>;
	private publicKeyByUserIdCache: MemoryKVCache<UserPublickey | null>;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.messagingMessagesRepository)
		private messagingMessagesRepository: MessagingMessagesRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.userPublickeysRepository)
		private userPublickeysRepository: UserPublickeysRepository,

		private cacheService: CacheService,
		private apPersonService: ApPersonService,
	) {
		this.publicKeyCache = new MemoryKVCache<UserPublickey | null>(Infinity);
		this.publicKeyByUserIdCache = new MemoryKVCache<UserPublickey | null>(Infinity);
	}

	@bindThis
	public parseUri(value: string | IObject): UriParseResult {
		const separator = '/';

		const uri = new URL(getApId(value));
		if (uri.origin !== this.config.url) return { local: false, uri: uri.href };

		const [, type, id, ...rest] = uri.pathname.split(separator);
		return {
			local: true,
			type,
			id,
			rest: rest.length === 0 ? undefined : rest.join(separator),
		};
	}

	/**
	 * AP Note => Misskey Note in DB
	 */
	@bindThis
	public async getNoteFromApId(value: string | IObject): Promise<Note | null> {
		const parsed = this.parseUri(value);

		if (parsed.local) {
			if (parsed.type !== 'notes') return null;

			return await this.notesRepository.findOneBy({
				id: parsed.id,
			});
		} else {
			return await this.notesRepository.findOneBy({
				uri: parsed.uri,
			});
		}
	}

	@bindThis
	public async getMessageFromApId(value: string | IObject): Promise<MessagingMessage | null> {
		const parsed = this.parseUri(value);

		if (parsed.local) {
			if (parsed.type !== 'notes') return null;

			return await this.messagingMessagesRepository.findOneBy({
				id: parsed.id,
			});
		} else {
			return await this.messagingMessagesRepository.findOneBy({
				uri: parsed.uri,
			});
		}
	}

	/**
	 * AP Person => Misskey User in DB
	 */
	@bindThis
	public async getUserFromApId(value: string | IObject): Promise<LocalUser | RemoteUser | null> {
		const parsed = this.parseUri(value);

		if (parsed.local) {
			if (parsed.type !== 'users') return null;

			return await this.cacheService.userByIdCache.fetchMaybe(parsed.id, () => this.usersRepository.findOneBy({
				id: parsed.id,
			}).then(x => x ?? undefined)) as LocalUser | undefined ?? null;
		} else {
			return await this.cacheService.uriPersonCache.fetch(parsed.uri, () => this.usersRepository.findOneBy({
				uri: parsed.uri,
			})) as RemoteUser | null;
		}
	}

	/**
	 * AP KeyId => Misskey User and Key
	 */
	@bindThis
	public async getAuthUserFromKeyId(keyId: string): Promise<{
		user: RemoteUser;
		key: UserPublickey;
	} | null> {
		const key = await this.publicKeyCache.fetch(keyId, async () => {
			const key = await this.userPublickeysRepository.findOneBy({
				keyId,
			});
	
			if (key == null) return null;

			return key;
		}, key => key != null);

		if (key == null) return null;

		return {
			user: await this.cacheService.findUserById(key.userId) as RemoteUser,
			key,
		};
	}

	/**
	 * AP Actor id => Misskey User and Key
	 */
	@bindThis
	public async getAuthUserFromApId(uri: string): Promise<{
		user: RemoteUser;
		key: UserPublickey | null;
	} | null> {
		const user = await this.apPersonService.resolvePerson(uri) as RemoteUser;

		if (user == null) return null;

		const key = await this.publicKeyByUserIdCache.fetch(user.id, () => this.userPublickeysRepository.findOneBy({ userId: user.id }), v => v != null); 

		return {
			user,
			key,
		};
	}

	@bindThis
	public dispose(): void {
		this.publicKeyCache.dispose();
		this.publicKeyByUserIdCache.dispose();
	}

	@bindThis
	public onApplicationShutdown(signal?: string | undefined): void {
		this.dispose();
	}
}
