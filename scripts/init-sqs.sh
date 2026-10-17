#!/usr/bin/env bash
set -euo pipefail

queue() {
  awslocal --endpoint-url "$SQS_ENDPOINT" sqs "$@"
}

dlq_url=$(queue create-queue --queue-name wager-transactions-dlq.fifo --attributes FifoQueue=true,MessageRetentionPeriod=1209600 --query QueueUrl --output text)
dlq_arn=$(queue get-queue-attributes --queue-url "$dlq_url" --attribute-names QueueArn --query Attributes.QueueArn --output text)
queue create-queue --queue-name wager-transactions.fifo --attributes "{\"FifoQueue\":\"true\",\"VisibilityTimeout\":\"60\",\"ReceiveMessageWaitTimeSeconds\":\"2\",\"MessageRetentionPeriod\":\"345600\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$dlq_arn\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"
queue create-queue --queue-name wager-events.fifo --attributes FifoQueue=true,MessageRetentionPeriod=345600
