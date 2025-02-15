import assert from 'assert'
import { gql } from '@apollo/client'
import { Knex } from 'knex'
import { v4 as uuid } from 'uuid'
import { ApolloError } from '@apollo/client'

import { createTestApp, TestContainer } from '../../tests/app'
import { IocContract } from '@adonisjs/fold'
import { AppServices } from '../../app'
import { Asset } from '../../asset/model'
import { initIocContainer } from '../..'
import { Config } from '../../config/app'
import { truncateTables } from '../../tests/tableManager'
import {
  PaymentPointerError,
  errorToCode,
  errorToMessage
} from '../../open_payments/payment_pointer/errors'
import {
  PaymentPointer as PaymentPointerModel,
  PaymentPointerEvent,
  PaymentPointerEventType
} from '../../open_payments/payment_pointer/model'
import { PaymentPointerService } from '../../open_payments/payment_pointer/service'
import { createAsset } from '../../tests/asset'
import { createPaymentPointer } from '../../tests/paymentPointer'
import {
  CreatePaymentPointerInput,
  CreatePaymentPointerMutationResponse,
  TriggerPaymentPointerEventsMutationResponse,
  PaymentPointer,
  PaymentPointerStatus,
  UpdatePaymentPointerMutationResponse,
  PaymentPointersConnection
} from '../generated/graphql'
import { getPageTests } from './page.test'

describe('Payment Pointer Resolvers', (): void => {
  let deps: IocContract<AppServices>
  let appContainer: TestContainer
  let knex: Knex
  let paymentPointerService: PaymentPointerService

  beforeAll(async (): Promise<void> => {
    deps = await initIocContainer(Config)
    appContainer = await createTestApp(deps)
    knex = appContainer.knex
    paymentPointerService = await deps.use('paymentPointerService')
  })

  afterEach(async (): Promise<void> => {
    await truncateTables(knex)
  })

  afterAll(async (): Promise<void> => {
    await appContainer.apolloClient.stop()
    await appContainer.shutdown()
  })

  describe('Create Payment Pointer', (): void => {
    let asset: Asset
    let input: CreatePaymentPointerInput

    beforeEach(async (): Promise<void> => {
      asset = await createAsset(deps)
      input = {
        assetId: asset.id,
        url: 'https://alice.me/.well-known/pay'
      }
    })

    test.each`
      publicName
      ${'Alice'}
      ${undefined}
    `(
      'Can create a payment pointer (publicName: $publicName)',
      async ({ publicName }): Promise<void> => {
        input.publicName = publicName
        const response = await appContainer.apolloClient
          .mutate({
            mutation: gql`
              mutation CreatePaymentPointer(
                $input: CreatePaymentPointerInput!
              ) {
                createPaymentPointer(input: $input) {
                  code
                  success
                  message
                  paymentPointer {
                    id
                    asset {
                      code
                      scale
                    }
                    url
                    publicName
                  }
                }
              }
            `,
            variables: {
              input
            }
          })
          .then((query): CreatePaymentPointerMutationResponse => {
            if (query.data) {
              return query.data.createPaymentPointer
            } else {
              throw new Error('Data was empty')
            }
          })

        expect(response.success).toBe(true)
        expect(response.code).toEqual('200')
        assert.ok(response.paymentPointer)
        expect(response.paymentPointer).toEqual({
          __typename: 'PaymentPointer',
          id: response.paymentPointer.id,
          url: input.url,
          asset: {
            __typename: 'Asset',
            code: asset.code,
            scale: asset.scale
          },
          publicName: publicName ?? null
        })
        await expect(
          paymentPointerService.get(response.paymentPointer.id)
        ).resolves.toMatchObject({
          id: response.paymentPointer.id,
          asset
        })
      }
    )

    test.each`
      error
      ${PaymentPointerError.InvalidUrl}
      ${PaymentPointerError.UnknownAsset}
    `('4XX - $error', async ({ error }): Promise<void> => {
      jest.spyOn(paymentPointerService, 'create').mockResolvedValueOnce(error)
      const response = await appContainer.apolloClient
        .mutate({
          mutation: gql`
            mutation CreatePaymentPointer($input: CreatePaymentPointerInput!) {
              createPaymentPointer(input: $input) {
                code
                success
                message
                paymentPointer {
                  id
                  asset {
                    code
                    scale
                  }
                }
              }
            }
          `,
          variables: {
            input
          }
        })
        .then((query): CreatePaymentPointerMutationResponse => {
          if (query.data) {
            return query.data.createPaymentPointer
          } else {
            throw new Error('Data was empty')
          }
        })

      expect(response.success).toBe(false)
      expect(response.code).toEqual(
        errorToCode[error as PaymentPointerError].toString()
      )
      expect(response.message).toEqual(
        errorToMessage[error as PaymentPointerError]
      )
    })

    test('500', async (): Promise<void> => {
      jest
        .spyOn(paymentPointerService, 'create')
        .mockImplementationOnce(async (_args) => {
          throw new Error('unexpected')
        })
      const response = await appContainer.apolloClient
        .mutate({
          mutation: gql`
            mutation CreatePaymentPointer($input: CreatePaymentPointerInput!) {
              createPaymentPointer(input: $input) {
                code
                success
                message
                paymentPointer {
                  id
                  asset {
                    code
                    scale
                  }
                }
              }
            }
          `,
          variables: {
            input
          }
        })
        .then((query): CreatePaymentPointerMutationResponse => {
          if (query.data) {
            return query.data.createPaymentPointer
          } else {
            throw new Error('Data was empty')
          }
        })
      expect(response.code).toBe('500')
      expect(response.success).toBe(false)
      expect(response.message).toBe('Error trying to create payment pointer')
    })
  })

  describe('Update Payment Pointer', (): void => {
    let paymentPointer: PaymentPointerModel

    beforeEach(async (): Promise<void> => {
      paymentPointer = await createPaymentPointer(deps)
    })

    test('Can update a payment pointer', async (): Promise<void> => {
      const updateOptions = {
        id: paymentPointer.id,
        status: PaymentPointerStatus.Inactive,
        publicName: 'Public Payment Pointer'
      }
      const response = await appContainer.apolloClient
        .mutate({
          mutation: gql`
            mutation UpdatePaymentPointer($input: UpdatePaymentPointerInput!) {
              updatePaymentPointer(input: $input) {
                code
                success
                message
                paymentPointer {
                  id
                  status
                  publicName
                }
              }
            }
          `,
          variables: {
            input: updateOptions
          }
        })
        .then((query): UpdatePaymentPointerMutationResponse => {
          if (query.data) {
            return query.data.updatePaymentPointer
          } else {
            throw new Error('Data was empty')
          }
        })

      expect(response.success).toBe(true)
      expect(response.code).toEqual('200')
      expect(response.paymentPointer).toEqual({
        __typename: 'PaymentPointer',
        ...updateOptions
      })

      const updatedPaymentPointer = await paymentPointerService.get(
        paymentPointer.id
      )
      assert.ok(updatedPaymentPointer)

      const {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        deactivatedAt,
        updatedAt: originalUpdatedAt,
        ...originalRest
      } = paymentPointer
      expect(updatedPaymentPointer).toMatchObject({
        ...originalRest,
        publicName: updateOptions.publicName
      })
      expect(updatedPaymentPointer.deactivatedAt).toBeDefined()
      expect(updatedPaymentPointer.isActive).toBe(false)
      expect(updatedPaymentPointer.updatedAt.getTime()).toBeGreaterThan(
        originalUpdatedAt.getTime()
      )
    })

    test.each`
      error
      ${PaymentPointerError.InvalidUrl}
      ${PaymentPointerError.UnknownAsset}
      ${PaymentPointerError.UnknownPaymentPointer}
    `('4XX - $error', async ({ error }): Promise<void> => {
      jest.spyOn(paymentPointerService, 'update').mockResolvedValueOnce(error)
      const response = await appContainer.apolloClient
        .mutate({
          mutation: gql`
            mutation UpdatePaymentPointer($input: UpdatePaymentPointerInput!) {
              updatePaymentPointer(input: $input) {
                code
                success
                message
                paymentPointer {
                  id
                }
              }
            }
          `,
          variables: {
            input: {
              id: paymentPointer.id,
              status: PaymentPointerStatus.Inactive
            }
          }
        })
        .then((query): UpdatePaymentPointerMutationResponse => {
          if (query.data) {
            return query.data.updatePaymentPointer
          } else {
            throw new Error('Data was empty')
          }
        })

      expect(response.success).toBe(false)
      expect(response.code).toEqual(
        errorToCode[error as PaymentPointerError].toString()
      )
      expect(response.message).toEqual(
        errorToMessage[error as PaymentPointerError]
      )
    })

    test('Returns error if unexpected error', async (): Promise<void> => {
      jest
        .spyOn(paymentPointerService, 'update')
        .mockImplementationOnce(async () => {
          throw new Error('unexpected')
        })
      const response = await appContainer.apolloClient
        .mutate({
          mutation: gql`
            mutation UpdatePaymentPointer($input: UpdatePaymentPointerInput!) {
              updatePaymentPointer(input: $input) {
                code
                success
                message
                paymentPointer {
                  id
                }
              }
            }
          `,
          variables: {
            input: {
              id: paymentPointer.id,
              status: PaymentPointerStatus.Inactive
            }
          }
        })
        .then((query): UpdatePaymentPointerMutationResponse => {
          if (query.data) {
            return query.data.updatePaymentPointer
          } else {
            throw new Error('Data was empty')
          }
        })

      expect(response.success).toBe(false)
      expect(response.code).toEqual('500')
      expect(response.message).toEqual('Error trying to update payment pointer')
    })
  })

  describe('Payment Pointer Queries', (): void => {
    test.each`
      publicName
      ${'Alice'}
      ${undefined}
    `(
      'Can get an payment pointer (publicName: $publicName)',
      async ({ publicName }): Promise<void> => {
        const paymentPointer = await createPaymentPointer(deps, {
          publicName
        })
        const query = await appContainer.apolloClient
          .query({
            query: gql`
              query PaymentPointer($paymentPointerId: String!) {
                paymentPointer(id: $paymentPointerId) {
                  id
                  asset {
                    code
                    scale
                  }
                  url
                  publicName
                }
              }
            `,
            variables: {
              paymentPointerId: paymentPointer.id
            }
          })
          .then((query): PaymentPointer => {
            if (query.data) {
              return query.data.paymentPointer
            } else {
              throw new Error('Data was empty')
            }
          })

        expect(query).toEqual({
          __typename: 'PaymentPointer',
          id: paymentPointer.id,
          asset: {
            __typename: 'Asset',
            code: paymentPointer.asset.code,
            scale: paymentPointer.asset.scale
          },
          url: paymentPointer.url,
          publicName: publicName ?? null
        })
      }
    )

    test('Returns error for unknown payment pointer', async (): Promise<void> => {
      const gqlQuery = appContainer.apolloClient
        .query({
          query: gql`
            query PaymentPointer($paymentPointerId: String!) {
              paymentPointer(id: $paymentPointerId) {
                id
              }
            }
          `,
          variables: {
            paymentPointerId: uuid()
          }
        })
        .then((query): PaymentPointer => {
          if (query.data) {
            return query.data.paymentPointer
          } else {
            throw new Error('Data was empty')
          }
        })

      await expect(gqlQuery).rejects.toThrow(ApolloError)
    })

    getPageTests({
      getClient: () => appContainer.apolloClient,
      createModel: () => createPaymentPointer(deps),
      pagedQuery: 'paymentPointers'
    })

    test('Can get page of payment pointers', async (): Promise<void> => {
      const paymentPointers: PaymentPointerModel[] = []
      for (let i = 0; i < 2; i++) {
        paymentPointers.push(await createPaymentPointer(deps))
      }
      const query = await appContainer.apolloClient
        .query({
          query: gql`
            query PaymentPointers {
              paymentPointers {
                edges {
                  node {
                    id
                    asset {
                      code
                      scale
                    }
                    url
                    publicName
                  }
                  cursor
                }
              }
            }
          `
        })
        .then((query): PaymentPointersConnection => {
          if (query.data) {
            return query.data.paymentPointers
          } else {
            throw new Error('Data was empty')
          }
        })

      expect(query.edges).toHaveLength(2)
      query.edges.forEach((edge, idx) => {
        const paymentPointer = paymentPointers[idx]
        expect(edge.cursor).toEqual(paymentPointer.id)
        expect(edge.node).toEqual({
          __typename: 'PaymentPointer',
          id: paymentPointer.id,
          asset: {
            __typename: 'Asset',
            code: paymentPointer.asset.code,
            scale: paymentPointer.asset.scale
          },
          url: paymentPointer.url,
          publicName: paymentPointer.publicName
        })
      })
    })
  })

  describe('Trigger Payment Pointer Events', (): void => {
    test.each`
      limit | count
      ${1}  | ${1}
      ${5}  | ${2}
    `(
      'Can trigger payment pointer events (limit: $limit)',
      async ({ limit, count }): Promise<void> => {
        const accountingService = await deps.use('accountingService')
        const paymentPointers: PaymentPointerModel[] = []
        const withdrawalAmount = BigInt(10)
        for (let i = 0; i < 3; i++) {
          const paymentPointer = await createPaymentPointer(deps, {
            createLiquidityAccount: true
          })
          if (i) {
            await expect(
              accountingService.createDeposit({
                id: uuid(),
                account: paymentPointer,
                amount: withdrawalAmount
              })
            ).resolves.toBeUndefined()
            await paymentPointer.$query(knex).patch({
              processAt: new Date()
            })
          }
          paymentPointers.push(paymentPointer)
        }
        const response = await appContainer.apolloClient
          .mutate({
            mutation: gql`
              mutation TriggerPaymentPointerEvents(
                $input: TriggerPaymentPointerEventsInput!
              ) {
                triggerPaymentPointerEvents(input: $input) {
                  code
                  success
                  message
                  count
                }
              }
            `,
            variables: {
              input: {
                limit,
                idempotencyKey: uuid()
              }
            }
          })
          .then((query): TriggerPaymentPointerEventsMutationResponse => {
            if (query.data) {
              return query.data.triggerPaymentPointerEvents
            } else {
              throw new Error('Data was empty')
            }
          })

        expect(response.success).toBe(true)
        expect(response.code).toEqual('200')
        expect(response.count).toEqual(count)
        await expect(
          PaymentPointerEvent.query(knex).where({
            type: PaymentPointerEventType.PaymentPointerWebMonetization
          })
        ).resolves.toHaveLength(count)
        for (let i = 1; i <= count; i++) {
          await expect(
            paymentPointerService.get(paymentPointers[i].id)
          ).resolves.toMatchObject({
            processAt: null,
            totalEventsAmount: withdrawalAmount
          })
        }
      }
    )

    test('500', async (): Promise<void> => {
      jest
        .spyOn(paymentPointerService, 'triggerEvents')
        .mockRejectedValueOnce(new Error('unexpected'))
      const response = await appContainer.apolloClient
        .mutate({
          mutation: gql`
            mutation TriggerPaymentPointerEvents(
              $input: TriggerPaymentPointerEventsInput!
            ) {
              triggerPaymentPointerEvents(input: $input) {
                code
                success
                message
                count
              }
            }
          `,
          variables: {
            input: {
              limit: 1
            }
          }
        })
        .then((query): TriggerPaymentPointerEventsMutationResponse => {
          if (query.data) {
            return query.data.triggerPaymentPointerEvents
          } else {
            throw new Error('Data was empty')
          }
        })
      expect(response.code).toBe('500')
      expect(response.success).toBe(false)
      expect(response.message).toBe(
        'Error trying to trigger payment pointer events'
      )
      expect(response.count).toBeNull()
    })
  })
})
