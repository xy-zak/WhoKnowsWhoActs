import type {
  FacilitatorAck,
  FacilitatorClientToServer,
  FacilitatorCommand,
  FacilitatorPayload,
  FacilitatorServerToClient,
  PlayerAcks,
  PlayerClientToServer,
  PlayerPayload,
  PlayerRequest,
  PlayerServerToClient,
} from "@wkwa/shared";
import type { Socket } from "socket.io-client";

/**
 * The browsers' sockets, typed with the shared event maps (@wkwa/shared socket.ts): every emit,
 * acknowledgement and listener is checked against the protocol by the compiler.
 */
export type PlayerSocket = Socket<PlayerServerToClient, PlayerClientToServer>;
export type FacilitatorSocket = Socket<FacilitatorServerToClient, FacilitatorClientToServer>;

/** Socket.IO's emit, seen without its event map (only used below). */
type UntypedEmit = (name: string, payload: unknown, ack: (a: never) => void) => unknown;

/*
 * `socket.emit(name, payload, ack)` for a message name that is a generic type parameter.
 * Socket.IO's emit types resolve the arguments for a concrete name only, so the generic wrappers
 * (PlayerConnection.request, FacilitatorConnection.cmd) go through these two. Their signatures
 * keep the name, the payload and the ack tied together through the shared event maps.
 */

export function emitPlayer<K extends PlayerRequest>(
  socket: PlayerSocket,
  name: K,
  payload: PlayerPayload<K>,
  ack: (a: PlayerAcks[K]) => void,
): void {
  (socket.emit as UntypedEmit).call(socket, name, payload, ack);
}

export function emitFacilitator<K extends FacilitatorCommand>(
  socket: FacilitatorSocket,
  name: K,
  payload: FacilitatorPayload<K>,
  ack: (a: FacilitatorAck<K>) => void,
): void {
  (socket.emit as UntypedEmit).call(socket, name, payload, ack);
}
