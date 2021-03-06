/* eslint-env mocha */
/* global assert contract */
const fs = require('fs');
const BN = require('bignumber.js');

const config = JSON.parse(fs.readFileSync('./conf/config.json'));
const paramConfig = config.paramDefaults;

const utils = require('../utils.js');

const bigTen = number => new BN(number.toString(10), 10);

contract('Registry', (accounts) => {
  describe('Function: claimReward', () => {
    const [applicant, challenger, voterAlice] = accounts;

    let token;
    let voting;
    let registry;
    let parameterizer;

    before(async () => {
      const {
        votingProxy,
        registryProxy,
        tokenInstance,
        paramProxy,
      } = await utils.getProxies();
      voting = votingProxy;
      registry = registryProxy;
      token = tokenInstance;
      parameterizer = paramProxy;

      await utils.approveProxies(accounts, token, voting, false, registry);
    });

    it('should transfer the correct number of tokens once a challenge has been resolved', async () => {
      const listing = utils.getListingHash('claimthis.net');

      // Apply
      await utils.as(applicant, registry.apply, listing, '');
      const aliceStartingBalance = await token.balanceOf.call(voterAlice);

      // Challenge
      const pollID = await utils.challengeAndGetPollID(listing, challenger, registry);

      // Alice is so committed
      await utils.commitVote(pollID, '0', 500, '420', voterAlice, voting);
      await utils.increaseTime(paramConfig.commitStageLength + 1);

      // Alice is so revealing
      await utils.as(voterAlice, voting.revealVote, pollID, '0', '420');
      await utils.increaseTime(paramConfig.revealStageLength + 1);

      // Update status
      await utils.as(applicant, registry.updateStatus, listing);
      // Alice claims reward
      const aliceVoterReward = await registry.voterReward.call(voterAlice, pollID, '420');
      const aliceInflationReward = await registry.voterInflationReward.call(voterAlice, pollID, '420');
      await utils.as(voterAlice, registry.claimReward, pollID, '420');
      // Alice withdraws her voting rights
      await utils.as(voterAlice, voting.withdrawVotingRights, '500');

      const aliceExpected = aliceStartingBalance.add(aliceVoterReward).add(aliceInflationReward);
      const aliceFinalBalance = await token.balanceOf.call(voterAlice);

      assert.strictEqual(
        aliceFinalBalance.toString(10), aliceExpected.toString(10),
        'alice should have the same balance as she started',
      );
    });

    it('should revert if challenge does not exist', async () => {
      try {
        const nonPollID = '666';
        await utils.as(voterAlice, registry.claimReward, nonPollID, '420');
      } catch (err) {
        assert(utils.isEVMException(err), err.toString());
        return;
      }
      assert(false, 'should not have been able to claimReward for non-existant challengeID');
    });

    it('should revert if provided salt is incorrect', async () => {
      const listing = utils.getListingHash('sugar.net');
      const minDeposit = await parameterizer.get.call('minDeposit');

      const applicantStartingBalance = await token.balanceOf.call(applicant);
      const aliceStartBal = await token.balanceOf.call(voterAlice);
      await utils.addToWhitelist(listing, applicant, registry);

      const pollID = await utils.challengeAndGetPollID(listing, challenger, registry);

      // Alice is so committed
      await utils.commitVote(pollID, '0', 500, '420', voterAlice, voting);
      await utils.increaseTime(paramConfig.commitStageLength + 1);

      // Alice is so revealing
      await utils.as(voterAlice, voting.revealVote, pollID, '0', '420');
      await utils.increaseTime(paramConfig.revealStageLength + 1);

      const applicantFinalBalance = await token.balanceOf.call(applicant);
      const aliceFinalBalance = await token.balanceOf.call(voterAlice);
      const expectedBalance = applicantStartingBalance.sub(minDeposit);

      assert.strictEqual(
        applicantFinalBalance.toString(10), expectedBalance.toString(10),
        'applicants final balance should be what they started with minus the minDeposit',
      );
      assert.strictEqual(
        aliceFinalBalance.toString(10), (aliceStartBal.sub(bigTen(500))).toString(10),
        'alices final balance should be exactly the same as her starting balance',
      );

      // Update status
      await utils.as(applicant, registry.updateStatus, listing);

      try {
        await utils.as(voterAlice, registry.claimReward, pollID, '421');
        assert(false, 'should not have been able to claimReward with the wrong salt');
      } catch (err) {
        assert(utils.isEVMException(err), err.toString());
      }
    });

    it('should not transfer tokens if msg.sender has already claimed tokens for a challenge', async () => {
      const listing = utils.getListingHash('sugar.net');
      const minDeposit = await parameterizer.get.call('minDeposit');

      const applicantStartingBalance = await token.balanceOf.call(applicant);

      await utils.addToWhitelist(listing, applicant, registry);

      // Challenge
      const pollID = await utils.challengeAndGetPollID(listing, challenger, registry);

      // Alice is so committed
      await utils.commitVote(pollID, '0', 500, '420', voterAlice, voting);
      await utils.increaseTime(paramConfig.commitStageLength + 1);

      // Alice is so revealing
      await utils.as(voterAlice, voting.revealVote, pollID, '0', '420');
      await utils.increaseTime(paramConfig.revealStageLength + 1);

      // Update status
      await utils.as(applicant, registry.updateStatus, listing);

      const aliceStartingBalance = await token.balanceOf.call(voterAlice);

      // Claim reward
      await utils.as(voterAlice, registry.claimReward, pollID, '420');

      try {
        await utils.as(voterAlice, registry.claimReward, pollID, '420');
        assert(false, 'should not have been able to call claimReward twice');
      } catch (err) {
        assert(utils.isEVMException(err), err.toString());
      }

      const applicantEndingBalance = await token.balanceOf.call(applicant);
      const appExpected = applicantStartingBalance.sub(minDeposit);

      assert.strictEqual(
        applicantEndingBalance.toString(10), appExpected.toString(10),
        'applicants ending balance is incorrect',
      );

      const aliceVoterReward = await registry.voterReward.call(voterAlice, pollID, '420');
      const aliceInflationReward = await registry.voterInflationReward.call(voterAlice, pollID, '420');

      const aliceEndingBalance = await token.balanceOf.call(voterAlice);
      const aliceExpected = aliceStartingBalance.add(aliceVoterReward).add(aliceInflationReward);

      assert.strictEqual(
        aliceEndingBalance.toString(10), aliceExpected.toString(10),
        'alices ending balance is incorrect',
      );
    });

    it('should not transfer tokens for an unresolved challenge', async () => {
      const listing = utils.getListingHash('unresolved.net');
      const minDeposit = await parameterizer.get.call('minDeposit');

      const applicantStartingBalance = await token.balanceOf.call(applicant);
      const aliceStartingBalance = await token.balanceOf.call(voterAlice);

      await utils.addToWhitelist(listing, applicant, registry);

      // Challenge
      const pollID = await utils.challengeAndGetPollID(listing, challenger, registry);

      // Alice is so committed
      await utils.commitVote(pollID, '0', 500, '420', voterAlice, voting);
      await utils.increaseTime(paramConfig.commitStageLength + 1);

      // Alice is so revealing
      await utils.as(voterAlice, voting.revealVote, pollID, '0', '420');
      await utils.increaseTime(paramConfig.revealStageLength + 1);

      try {
        await utils.as(voterAlice, registry.claimReward, pollID, '420');
        assert(false, 'should not have been able to claimReward for unresolved challenge');
      } catch (err) {
        assert(utils.isEVMException(err), err.toString());
      }

      const applicantEndingBalance = await token.balanceOf.call(applicant);
      const appExpected = applicantStartingBalance.sub(minDeposit);

      const aliceEndingBalance = await token.balanceOf.call(voterAlice);
      const aliceExpected = aliceStartingBalance.sub(bigTen(500));

      assert.strictEqual(
        applicantEndingBalance.toString(10), appExpected.toString(10),
        'applicants ending balance is incorrect',
      );
      assert.strictEqual(
        aliceEndingBalance.toString(10), aliceExpected.toString(10),
        'alices ending balance is incorrect',
      );
    });
  });
});

