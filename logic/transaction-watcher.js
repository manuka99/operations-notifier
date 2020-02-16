const {horizon} = require('./stellar-connector'),
    {parseTransaction} = require('./stream-processor'),
    {matches} = require('../util/subscription-match-helper'),
    storage = require('./storage')

const transactionsBatchSize = 200

function fetchTransactions(cursor, ledgerSequence = undefined) {
    let builder = horizon
        .transactions()
    if (ledgerSequence !== undefined) {
        builder = builder.forLedger(ledgerSequence)
    }
    if (cursor !== undefined) {
        builder = builder.cursor(cursor)
    }
    return builder
        .order('asc')
        .limit(transactionsBatchSize)
        .call()
}

/**
 * Tracks transactions using event streaming from Horizon server
 */
class TransactionWatcher {
    constructor(observer) {
        this.queue = []
        this.processing = false
        this.observer = observer
    }

    /**
     * Add transactions to the processing queue
     * @param {Array<Transaction>}transactions
     */
    enqueue(transactions) {
        if (!transactions || !transactions.length) return
        Array.prototype.push.apply(this.queue, transactions)
        this.processQueue()
    }

    /**
     * Pick the entry from the queue and process it
     */
    processQueue() {
        //TODO: check method performance under the maximum load
        if (!this.observer.subscriptions || !this.observer.observing || !this.queue.length || this.processing) return
        this.processing = true
        const rawTx = this.queue.pop(),
            tx = parseTransaction(rawTx),
            notifications = [],
            relevantSubscriptions = new Set()

        if (!tx) { //failed to parse transaction
            this.processing = false
            return this.processQueue()
        }
        for (const operation of tx.operations) {
            //create a notification
            let notification = {
                payload: operation,
                subscriptions: []
            }
            //iterate through subscriptions
            for (const subscription of this.observer.subscriptions) {
                //TODO: ignore subscriptions that were added AFTER the tx ledger close date to prevent false notifications on fast-forwarding
                //find subscriptions that match an operation
                if (matches(subscription, operation)) {
                    //associate a subscription with current notification
                    notification.subscriptions.push(subscription.id)
                    //will use it once notifications are persisted
                    relevantSubscriptions.add(subscription)
                    //mark subscription as ready to be processed
                    subscription.processed = false
                }
            }

            //process a notification if at least one match was found
            if (notification.subscriptions.length) {
                notifications.push(notification)
            }
        }

        this.observer.notifier.createNotifications(notifications)
            .then(notifications => {
                storage.updateLastIngestedTx(tx.details.paging_token)
                    .catch(err => console.error(err))
                //iterate through processed subscriptions
                for (let subscription of relevantSubscriptions) {
                    //cache notifications directly inside the subscription
                    if (!subscription.notifications) {
                        subscription.notifications = new Set()
                    }
                    for (let notification of notifications) {
                        if (notification.subscriptions.some(s => s == subscription.id)) {
                            subscription.notifications.add(notification)
                        }
                    }
                }

                this.processing = false
                setImmediate(() => this.processQueue())
                this.observer.notifier.startNewNotifierThread()
            })
    }

    /**
     * Start watching
     */
    watch() {
        if (this.releaseStream) return
        storage.getLastIngestedTx()
            .then(cursor => {
                this.cursor = cursor
                this.trackTransactions()
            })
    }

    /**
     * Fast-forward transaction tracking from the last known tx
     */
    trackTransactions() {
        if (!this.observer.observing) return // redundant check
        if (!this.cursor || this.cursor === '0') return this.trackLiveStream()

        //check previously set cursor
        fetchTransactions(this.cursor)
            .then(({records}) => {
                if (!records || !records.length) {
                    this.trackLiveStream()
                } else {
                    this.enqueue(records)
                    setImmediate(() => this.trackTransactions())
                }
            })
            .catch(err => {
                console.error(err)
                this.stopWatching() //TODO: add bulletproof error handling with resume on error
            })

    }

    /**
     * Track live transactions stream from the Horizon server
     */
    trackLiveStream() {
        //subscribe to transactions live stream
        this.releaseStream = horizon
            .ledgers()
            .order('asc')
            .cursor('now')
            .stream({
                onmessage: (rawLedger) => {
                    this.loadLedgerTransactions(rawLedger.sequence)
                    //this.enqueue([rawTx])
                }
            })
    }

    loadLedgerTransactions(sequence, txCursor) {
        return new Promise((resolve, reject) => {
            const fetchLedgerTxBatch = () => {
                fetchTransactions(txCursor, sequence)
                    .then(({records}) => {
                        if (!records || !records.length) return resolve()
                        this.enqueue(records)
                        const fetchedCount = records.length
                        if (fetchedCount < transactionsBatchSize) return resolve() //saves one call when we are sure that we fetched the last batch
                        fetchLedgerTxBatch(records[fetchedCount - 1].paging_token)
                    })
                    .catch(e => reject(e))
            }
            fetchLedgerTxBatch(txCursor)
        })

    }

    /**
     * Terminates watching stream
     */
    stopWatching() {
        this.releaseStream && this.releaseStream()
    }
}

module.exports = TransactionWatcher