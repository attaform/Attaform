import { describe, expect, it } from 'vitest'
import {
  AttaformError,
  InvalidPathError,
  OutsideSetupError,
  RegistryNotInstalledError,
  ReservedFormKeyError,
  SubmitErrorHandlerError,
} from '../../src/runtime/core/errors'

describe('error classes', () => {
  describe('InvalidPathError', () => {
    it('extends Error and preserves the message', () => {
      const err = new InvalidPathError('bad path')
      expect(err).toBeInstanceOf(Error)
      expect(err).toBeInstanceOf(InvalidPathError)
      expect(err.message).toBe('bad path')
      expect(err.name).toBe('InvalidPathError')
    })

    it('preserves cause via ErrorOptions', () => {
      const inner = new TypeError('inner')
      const err = new InvalidPathError('outer', { cause: inner })
      expect(err.cause).toBe(inner)
    })

    it('throws with instanceof-checkable type across module boundaries', () => {
      const thrown = ((): unknown => {
        try {
          throw new InvalidPathError('x')
        } catch (e) {
          return e
        }
      })()
      expect(thrown).toBeInstanceOf(InvalidPathError)
    })
  })

  describe('SubmitErrorHandlerError', () => {
    it('extends Error with correct name', () => {
      const err = new SubmitErrorHandlerError('onError threw')
      expect(err).toBeInstanceOf(Error)
      expect(err).toBeInstanceOf(SubmitErrorHandlerError)
      expect(err.name).toBe('SubmitErrorHandlerError')
    })
  })

  describe('RegistryNotInstalledError', () => {
    it('has a helpful default message pointing at createAttaform', () => {
      const err = new RegistryNotInstalledError()
      expect(err.message).toContain('createAttaform')
      expect(err.name).toBe('RegistryNotInstalledError')
    })
  })

  describe('OutsideSetupError', () => {
    it('extends Error with correct name', () => {
      const err = new OutsideSetupError()
      expect(err).toBeInstanceOf(Error)
      expect(err).toBeInstanceOf(OutsideSetupError)
      expect(err.name).toBe('OutsideSetupError')
    })

    it('message names the lifecycle constraint and the recommended fix', () => {
      const err = new OutsideSetupError()
      // Surface the actual cause — not "install the plugin", which was
      // the misleading message before the disambiguation.
      expect(err.message).toContain('outside Vue setup')
      // Point at the recovery path users actually need.
      expect(err.message).toContain('child component')
    })
  })

  // AttaformError is the shared parent of every library-emitted error class so
  // consumers can write a single polymorphic catch (`catch (e) { if (e
  // instanceof AttaformError) ... }`) instead of OR-chaining instanceof
  // checks for every subclass. The migration is a clean break — the
  // class shape is additive (Error stays in the prototype chain) but the
  // public surface gains a new symbol.
  describe('AttaformError base class', () => {
    it('all library error classes are instanceof AttaformError', () => {
      expect(new InvalidPathError('x')).toBeInstanceOf(AttaformError)
      expect(new SubmitErrorHandlerError('x')).toBeInstanceOf(AttaformError)
      expect(new RegistryNotInstalledError()).toBeInstanceOf(AttaformError)
      expect(new OutsideSetupError()).toBeInstanceOf(AttaformError)
      expect(new ReservedFormKeyError('__atta:foo')).toBeInstanceOf(AttaformError)
    })

    it('still extends Error so consumers using catch (e: Error) keep working', () => {
      expect(new InvalidPathError('x')).toBeInstanceOf(Error)
    })

    it('preserves message + cause + name on the subclass when caught as AttaformError', () => {
      const inner = new TypeError('inner')
      let captured: AttaformError | undefined
      try {
        throw new InvalidPathError('outer', { cause: inner })
      } catch (e) {
        if (e instanceof AttaformError) captured = e
      }
      expect(captured).toBeDefined()
      expect(captured?.message).toBe('outer')
      expect(captured?.cause).toBe(inner)
      expect(captured?.name).toBe('InvalidPathError')
    })
  })
})
